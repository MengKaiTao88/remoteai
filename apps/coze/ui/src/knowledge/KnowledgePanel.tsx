import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Drawer, Empty, Input, InputNumber, List, Popconfirm, Space, Tag, Upload } from "antd";
import { BookOpen, FileUp, Trash2 } from "lucide-react";
import { api, errorText, fileBase64 } from "../api";
import type { Citation, Document, Resource } from "../types";

export function KnowledgePanel({ resource }: { resource: Resource }) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Citation[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [size, setSize] = useState(500);
  const [overlap, setOverlap] = useState(80);
  const [preview, setPreview] = useState<{ name: string; chunks: { id: string; text: string }[] }>();
  const [editing, setEditing] = useState<{ id: string; text: string; previous: string }>();
  const refresh = useCallback(async () => setDocuments(await api<Document[]>("list_documents", { id: resource.id })),
    [resource.id]);
  useEffect(() => { void refresh().catch((error: unknown) => setError(errorText(error))); }, [refresh]);
  const upload = async (file: File) => {
    if (busy) return;
    if (file.size > 32 * 1024 * 1024) { setError("请选择不超过 32 MB 的文件。"); return; }
    setBusy("import"); setError("");
    try {
      await api("import_document", { knowledgeId: resource.id, name: file.name,
        contentBase64: await fileBase64(file), chunk: { size, overlap } });
      await refresh();
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(""); }
  };
  const search = async () => {
    setBusy("search"); setError("");
    try { setResults(await api<Citation[]>("search", { knowledgeIds: [resource.id], query, limit: 6 })); }
    catch (error) { setError(errorText(error)); } finally { setBusy(""); }
  };
  return <div className="two-columns">
    <section className="panel"><h2>文档 <Tag>{documents.length}</Tag></h2>
      <p>导入文件后自动整理知识，在智能体和工作流中引用。</p>
      {error && <Alert type="error" message={error} />}
      <Space wrap><label>分段字数 <InputNumber aria-label="分段字数" min={100} max={2000} value={size}
        onChange={(value) => setSize(value ?? 500)} /></label>
        <label>重叠字数 <InputNumber aria-label="重叠字数" min={0} max={Math.floor(size / 2) - 1}
          value={overlap} onChange={(value) => setOverlap(value ?? 0)} /></label></Space>
      <Upload.Dragger accept=".txt,.md,.markdown,.pdf,.docx,.csv,.json,.tsv,.xlsx" showUploadList={false}
        disabled={Boolean(busy)} beforeUpload={(file) => { void upload(file); return false; }}>
        <FileUp size={30} /><p>{busy === "import" ? "正在整理文档，完成后即可检索…" : "拖放文件到这里，或点击选择"}</p>
        <small>支持 PDF、Word、Excel、Markdown 和文本，单个文件最大 32 MB</small>
      </Upload.Dragger>
      <List dataSource={documents} locale={{ emptyText: "还没有文档" }} renderItem={(document) => <List.Item actions={[
        <Button key="view" type="text" onClick={() => void api<{ id: string; text: string }[]>("read_chunks",
          { id: document.id }).then((chunks) => setPreview({ name: document.name, chunks }))
          .catch((error: unknown) => setError(errorText(error)))}>查看分段</Button>,
        <Popconfirm key="delete" title="删除此文档和它的全部分段？" overlayStyle={{ maxWidth: 400 }}
          onConfirm={async () => { try { await api("delete_document", { id: document.id }); await refresh(); }
            catch (error) { setError(errorText(error)); } }}>
          <Button type="text" danger icon={<Trash2 size={15} />} aria-label={`删除 ${document.name}`} />
        </Popconfirm>,
      ]}><List.Item.Meta avatar={<BookOpen size={20} />} title={document.name}
        description={`${document.chunks} 个分段 · ${(document.bytes / 1024).toFixed(1)} KB`} /></List.Item>} />
    </section>
    <section className="panel"><h2>检索测试</h2><p>输入问题，查看知识库能够找到的内容。</p>
      <Input.Search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="试着问一个问题"
        enterButton="检索" loading={busy === "search"} disabled={Boolean(busy) || !documents.length}
        onSearch={() => { if (query.trim()) void search(); }} />
      {!results.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="检索结果将显示在这里" />}
      {results.map((item, index) => <article className="citation" key={item.chunkId}>
        <strong>[{index + 1}] {item.documentName}</strong><p>{item.text}</p></article>)}
    </section>
    <Drawer title={preview?.name} open={Boolean(preview)} onClose={() => setPreview(undefined)} width={600}>
      {preview?.chunks.map((chunk, index) => <article className="citation" key={chunk.id}>
        <strong>分段 {index + 1}</strong>{editing?.id === chunk.id ? <>
          <Input.TextArea rows={8} value={editing.text} maxLength={2000}
            onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
          <Space><Button loading={busy === "edit"} onClick={() => {
            setBusy("edit");
            void api("update_chunk", editing).then(() => {
              setPreview({ ...preview, chunks: preview.chunks.map((item) => item.id === editing.id
                ? { ...item, text: editing.text } : item) }); setEditing(undefined);
            }).catch((error: unknown) => setError(errorText(error))).finally(() => setBusy(""));
          }}>保存分段</Button><Button onClick={() => setEditing(undefined)}>取消</Button></Space>
        </> : <><p>{chunk.text}</p><Button type="text" onClick={() => setEditing({ ...chunk, previous: chunk.text })}>
          编辑分段</Button></>}</article>)}
    </Drawer>
  </div>;
}
