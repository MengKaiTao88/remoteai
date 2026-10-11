import { useEffect, useState } from "react";
import { Alert, Button, Input, InputNumber, List, Select, Space, Tag, Typography } from "antd";
import { Copy, KeyRound } from "lucide-react";
import { api, errorText } from "../api";

type Role = "viewer" | "runner" | "editor";
interface Grant { id: string; name: string; role: Role; expiresAt: string; revokedAt: string | null }
interface Props { appId: string; published: boolean }
const roles = { viewer: "仅查看", runner: "查看和使用", editor: "查看、使用和编辑" };

export function AccessPanel({ appId, published }: Props) {
  const [items, setItems] = useState<Grant[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("runner");
  const [days, setDays] = useState(30);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState(false);
  const refresh = () => api<Grant[]>("list_access", { id: appId }).then(setItems);
  useEffect(() => {
    let current = true;
    void api<{ role: string }>("access_info").then((info) => {
      if (!current) return;
      setOwner(info.role === "owner");
      if (info.role === "owner") void refresh().catch((error: unknown) => setError(errorText(error)));
    }).catch((error: unknown) => { if (current) setError(errorText(error)); });
    return () => { current = false; };
  }, [appId]);
  if (!owner) return null;
  const issue = async () => {
    setBusy(true); setError(""); setCopied(false);
    try {
      const grant = await api<{ token: string }>("issue_access", { appId, name, role, expiresDays: days });
      setLink(`${location.origin}/#token=${encodeURIComponent(grant.token)}`);
      setName(""); await refresh();
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    setBusy(true); setError("");
    try { await api("revoke_access", { id }); await refresh(); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); }
    catch { setError("复制未完成，请选中链接后复制。"); }
  };
  return <section className="panel"><h2><KeyRound size={18} /> 应用访问</h2>
    <Typography.Paragraph type="secondary">
      为这台电脑上的使用者创建访问链接。可分别设置权限，并随时停用。
    </Typography.Paragraph>
    {!published && <Alert type="info" message="发布应用后，即可创建访问链接。" />}
    {error && <Alert type="error" message={error} closable onClose={() => setError("")} />}
    <Space wrap><Input value={name} maxLength={80} placeholder="使用者或用途" style={{ width: 180 }}
      onChange={(event) => setName(event.target.value)} />
      <Select value={role} onChange={setRole} style={{ minWidth: 155 }}
        options={Object.entries(roles).map(([value, label]) => ({ value, label }))} />
      <InputNumber min={1} max={365} value={days} addonAfter="天" onChange={(value) => setDays(value ?? 30)} />
      <Button type="primary" disabled={!published || !name.trim()} loading={busy} onClick={() => void issue()}>
        创建链接</Button></Space>
    {link && <Alert type="success" message="链接已创建，请复制保存。"
      description={<Space.Compact className="full"><Input readOnly value={link} aria-label="应用访问链接" />
        <Button icon={<Copy size={14} />} onClick={() => void copy()}>{copied ? "已复制" : "复制"}</Button>
      </Space.Compact>} closable onClose={() => setLink("")} />}
    <List dataSource={items} locale={{ emptyText: "暂无访问链接" }} renderItem={(item) =>
      <List.Item actions={[<Button key="revoke" danger size="small" disabled={!!item.revokedAt || busy}
        onClick={() => void revoke(item.id)}>{item.revokedAt ? "已停用" : "停用"}</Button>]}>
        <List.Item.Meta title={<Space>{item.name}<Tag>{roles[item.role]}</Tag></Space>}
          description={`有效期至 ${new Date(item.expiresAt).toLocaleDateString()}`} />
      </List.Item>} />
  </section>;
}
