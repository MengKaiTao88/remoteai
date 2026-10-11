import { useState } from "react";
import { Alert, Button, Modal, Space, Upload } from "antd";
import { errorText } from "../api";

export function BackupButton({ onRestored }: { onRestored: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const perform = async (file?: File) => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/backup", { method: file ? "POST" : "GET", body: file,
        headers: { Authorization: `Bearer ${sessionStorage.getItem("coze-session") ?? ""}` } });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? "备份操作未完成，请稍后重试。");
      }
      if (file) { onRestored(); setOpen(false); return; }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = url;
      anchor.download = `coze-${new Date().toISOString().slice(0, 10)}.coze`; anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  const restore = (file: File) => {
    Modal.confirm({ title: "用备份替换当前内容？", width: 400,
      content: "当前内容会被替换，分享链接会失效。建议先下载一份备份。",
      okText: "恢复备份", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => perform(file) });
    return false;
  };
  return <><Button type="text" onClick={() => setOpen(true)}>备份与恢复</Button>
    <Modal title="备份与恢复" open={open} width={400} footer={null} onCancel={() => setOpen(false)}>
      <p>备份包含应用、原始文档、知识索引、对话、发布版本和运行记录。</p>
      <Space><Button loading={busy} onClick={() => void perform()}>下载完整备份</Button>
        <Upload accept=".coze" beforeUpload={restore} showUploadList={false} disabled={busy}>
          <Button disabled={busy}>恢复备份</Button></Upload></Space>
      {error && <Alert style={{ marginTop: 12 }} type="error" message={error} />}
    </Modal></>;
}
