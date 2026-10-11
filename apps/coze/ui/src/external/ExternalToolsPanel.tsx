import { useEffect, useState } from "react";
import { Alert, Button, Input, InputNumber, List, Popconfirm, Select, Space, Tag, Typography } from "antd";
import type { Resource } from "../types";
import { ConnectionExamples } from "./ConnectionExamples";
import { useExternalTools, type ToolSettings } from "./useExternalTools";

export function ExternalToolsPanel({ resource }: { resource: Resource }) {
  const tools = useExternalTools(resource.id);
  const [settings, setSettings] = useState<ToolSettings>({ enabled: false, mode: "local", port: 15461 });
  const [name, setName] = useState("");
  const [days, setDays] = useState(30);
  useEffect(() => { if (tools.status) setSettings(tools.status.settings); }, [tools.status]);
  const published = resource.mcpEnabled && Boolean(resource.publishedRevision);
  const enabled = tools.status?.settings.enabled === true;
  return <section className="panel">
    <h2>外部调用</h2>
    <p>让其他应用通过 MCP 或 API 使用这项内容。先发布，再创建专用密钥。</p>
    <p>在 Codex GUI 中输入 <strong>#{resource.name}</strong> 并选择，即可在对话中调用。</p>
    {tools.error && <Alert type="error" message={tools.error} closable onClose={() => tools.setError("")} />}
    <h3>连接范围</h3><p>此设置适用于本机所有已开放的 Coze 内容。关闭后会暂停全部外部调用。</p>
    <Space wrap>
      <Select aria-label="连接范围" value={settings.mode} disabled={enabled || tools.busy}
        style={{ minWidth: 200 }} onChange={(mode) => setSettings({ ...settings, mode })}
        options={[{ value: "local", label: "仅本机应用" }, { value: "network", label: "允许其他电脑" }]} />
      <InputNumber aria-label="调用端口" min={1024} max={65535} value={settings.port}
        disabled={enabled || tools.busy} addonBefore="端口"
        onChange={(port) => setSettings({ ...settings, port: port ?? 15461 })} />
      {enabled ? <Popconfirm title="暂停全部外部调用？" styles={{ root: { maxWidth: 400 } }}
        onConfirm={() => tools.configure({ ...settings, enabled: false })}>
        <Button loading={tools.busy}>关闭外部调用</Button>
      </Popconfirm> : <Button type="primary" disabled={!tools.status} loading={tools.busy}
        onClick={() => void tools.configure({ ...settings, enabled: true })}>开启外部调用</Button>}
    </Space>
    {settings.mode === "network" && <p>其他电脑需能连接此电脑的地址和端口，并在防火墙中放行。
      跨公网使用时，请通过 VPN 或 HTTPS 网关连接。</p>}
    <h3>调用密钥</h3>
    {!published && <Alert type="info" message="请先发布此内容，再创建调用密钥。" />}
    <Space wrap>
      <Input aria-label="密钥用途" value={name} maxLength={80} placeholder="应用名称或用途"
        style={{ width: 200 }} onChange={(event) => setName(event.target.value)} />
      <InputNumber aria-label="密钥有效天数" min={1} max={365} value={days} addonAfter="天"
        onChange={(value) => setDays(value ?? 30)} />
      <Button disabled={!published || !name.trim()} loading={tools.busy}
        onClick={() => void tools.issue(name, days)}>创建密钥</Button>
    </Space>
    {tools.issued && <Alert type="success" message="密钥仅显示这一次，请复制保存。"
      closable onClose={tools.clearIssued} description={<Typography.Paragraph
        copyable={{ text: tools.issued.token }} style={{ overflowWrap: "anywhere", marginBottom: 0 }}>
        {tools.issued.token}</Typography.Paragraph>} />}
    <List dataSource={tools.items} locale={{ emptyText: "暂无调用密钥" }} renderItem={(item) => {
      const expired = new Date(item.expiresAt).getTime() <= Date.now();
      return <List.Item actions={[<Button key="revoke" danger size="small"
        disabled={!!item.revokedAt || tools.busy} onClick={() => void tools.revoke(item.id)}>
        {item.revokedAt ? "已停用" : "停用"}</Button>]}>
        <List.Item.Meta title={<Space>{item.name}{expired && <Tag>已过期</Tag>}</Space>}
          description={`有效期至 ${new Date(item.expiresAt).toLocaleDateString()}`} />
      </List.Item>;
    }} />
    <ConnectionExamples resource={resource} urls={tools.status?.urls ?? []} token={tools.issued?.token} />
  </section>;
}
