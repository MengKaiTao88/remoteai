import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Select, Space, Tabs, Upload } from "antd";
import { FileUp } from "lucide-react";
import { api, errorText, fileBase64 } from "../api";
import type { Model } from "../types";
import type { useKnowledgeJob } from "./useKnowledgeJob";

interface Props {
  knowledgeId: string; chunk: { size: number; overlap: number };
  job: ReturnType<typeof useKnowledgeJob>; onError: (error: string) => void;
}

export function KnowledgeImport({ knowledgeId, chunk, job, onError }: Props) {
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [ocr, setOcr] = useState(false);
  const [url, setUrl] = useState("");
  const [reading, setReading] = useState(false);
  const busy = reading || job.busy;
  useEffect(() => {
    let active = true;
    void api<Model[]>("models").then((items) => { if (active) setModels(items); }).catch(() => {
      // Text and web imports remain available if the local model list is temporarily unavailable.
    });
    return () => { active = false; };
  }, []);
  const upload = async (file: File) => {
    if (busy) return;
    if (file.size > 32 * 1024 * 1024) { onError("请选择不超过 32 MB 的文件。"); return; }
    const image = /\.(png|jpe?g|webp)$/i.test(file.name);
    const visual = image || (ocr && /\.pdf$/i.test(file.name));
    if (visual && !model) { onError("请先选择支持图片识别的模型。"); return; }
    if (image && file.size > 16 * 1024 * 1024) { onError("请选择不超过 16 MB 的图片。"); return; }
    setReading(true);
    try {
      await job.start(visual ? "import_media_document_start" : "import_document_start", {
        knowledgeId, name: file.name, contentBase64: await fileBase64(file), chunk, ...(visual ? { model } : {}),
      });
    } catch (error) { onError(errorText(error)); } finally { setReading(false); }
  };
  return <Tabs items={[
    { key: "file", label: "文件与图片", children: <Space direction="vertical" style={{ width: "100%" }}>
      <Select aria-label="图片识别模型" placeholder="识别图片时，请选择支持图片的模型" showSearch
        style={{ width: "100%" }} value={model || undefined} onChange={setModel} disabled={busy}
        options={models.map((item) => ({ value: item.id, label: item.name }))} />
      <Checkbox checked={ocr} onChange={(event) => setOcr(event.target.checked)} disabled={busy}>
        识别扫描 PDF 中的文字</Checkbox>
      <Upload.Dragger accept=".txt,.md,.markdown,.pdf,.docx,.csv,.json,.tsv,.xlsx,.png,.jpg,.jpeg,.webp"
        showUploadList={false} disabled={busy} beforeUpload={(file) => { void upload(file); return false; }}>
        <FileUp size={30} /><p>{busy ? "正在整理内容，请稍候…" : "拖放文件到这里，或点击选择"}</p>
        <small>文档最大 32 MB，图片最大 16 MB；扫描 PDF 最多 50 页。</small>
      </Upload.Dragger>
      <small>图片和扫描件将交给所选模型识别，完成后可以查看并修正分段内容。</small>
    </Space> },
    { key: "web", label: "网页", children: <Space direction="vertical" style={{ width: "100%" }}>
      <Input aria-label="网页地址" placeholder="https://example.com/article" value={url}
        onChange={(event) => setUrl(event.target.value)} disabled={busy} />
      <Button type="primary" loading={busy} disabled={!url.trim()} onClick={() => void job.start(
        "import_web_document_start", { knowledgeId, url: url.trim(), chunk })}>导入网页</Button>
      <small>导入公开网页中的文字。需要登录或只能在浏览器中加载的内容，请另存为文件后导入。</small>
    </Space> },
  ]} />;
}
