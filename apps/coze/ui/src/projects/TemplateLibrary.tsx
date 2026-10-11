import { useEffect, useState } from "react";
import { Alert, Button, Empty, Modal, Popconfirm, Space, Upload } from "antd";
import { LayoutTemplate, Upload as UploadIcon } from "lucide-react";
import { api, errorText } from "../api";

interface Template { id: string; name: string; description: string; builtin: boolean }
export function TemplateLibrary({ onInstalled }: { onInstalled: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Template[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => setItems(await api<Template[]>("list_templates"));
  useEffect(() => {
    if (open) void refresh().catch((error: unknown) => setError(errorText(error)));
  }, [open]);
  const perform = async (task: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await task(); } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  const install = (id: string) => perform(async () => {
    const result = await api<{ entryId: string }>("install_template", { id });
    setOpen(false); onInstalled(result.entryId);
  });
  const download = (id: string) => perform(async () => {
    const bundle = await api<unknown>("get_template", { id });
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "coze-template.json";
    anchor.click(); URL.revokeObjectURL(url);
  });
  const upload = (file: File) => {
    void perform(async () => {
      if (file.size > 4 * 1024 * 1024) throw new Error("请选择不超过 4 MB 的模板文件。");
      const value: unknown = JSON.parse(await file.text());
      await api("save_template", value); await refresh();
    });
    return false;
  };
  return <><button className="studio-nav-button" aria-label="模板广场" onClick={() => setOpen(true)}>
    <LayoutTemplate size={18} /><span>模板广场</span></button>
    <Modal className="studio-dialog" title="模板广场" width={760} open={open} centered
      footer={null} onCancel={() => setOpen(false)}>
      <div className="template-library-intro"><div><p>从模板开始，让想法更快成形。</p>
        <small>模板包含可复用的配置，不包含私有文档和对话。</small></div>
        <Upload accept=".json" beforeUpload={upload} showUploadList={false} disabled={busy}>
          <Button icon={<UploadIcon size={16} />} disabled={busy}>导入模板</Button></Upload>
      </div>
      {error && <Alert type="error" message={error} />}
      {items.length === 0 ? <Empty description="还没有模板" /> : <div className="template-grid">
        {items.map((item) => <article key={item.id} className="template-card">
          <header><span className="template-icon"><LayoutTemplate size={20} /></span>
            <small>{item.builtin ? "内置模板" : "自定义模板"}</small></header>
          <h3>{item.name}</h3><p>{item.description}</p><Space wrap>
            <Button type="primary" loading={busy} onClick={() => void install(item.id)}>使用模板</Button>
            <Button disabled={busy} onClick={() => void download(item.id)}>导出</Button>
            {!item.builtin && <Popconfirm title="从模板广场移除？已创建的内容会保留。"
              styles={{ root: { maxWidth: 400 } }} onConfirm={() => perform(async () => {
                await api("delete_template", { id: item.id }); await refresh();
              })}><Button danger disabled={busy}>移除</Button></Popconfirm>}
          </Space></article>)}
      </div>}
    </Modal></>;
}
