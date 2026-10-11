import { useState } from "react";
import { Button, Card, Empty, List, Space, Tag, Typography } from "antd";
import { AgentPreview } from "../agents/AgentPreview";
import { ResourceEditor } from "../ResourceEditor";
import { labels, type Resource } from "../types";
import { SharedWorkflow } from "./SharedWorkflow";

export interface AccessInfo { role: string; appId?: string }
interface Props { access: AccessInfo; resources: Resource[]; onSaved: (resource: Resource) => void }
const roleLabels: Record<string, string> = { viewer: "仅查看", runner: "查看和使用", editor: "可编辑" };

export function SharedAppView({ access, resources, onSaved }: Props) {
  const [selected, setSelected] = useState<string>();
  const resource = resources.find((item) => item.id === selected);
  const app = resources.find((item) => item.id === access.appId);
  const entry = resources.find((item) => item.id === app?.draft.entryId);
  if (!app) return <Empty description="应用暂不可用，请联系分享者。" />;
  if (resource && access.role === "editor") return <ResourceEditor key={resource.id} resource={resource}
    resources={resources} manage={false} onSaved={onSaved} onBack={() => setSelected(undefined)} onDirty={() => undefined} />;
  return <main className="studio-main">
    <header className="collection-header"><div><h1>{app.name}</h1>
      <Typography.Paragraph>{app.description || "欢迎使用这个应用。"}</Typography.Paragraph></div>
      <Tag>{roleLabels[access.role] ?? "共享访问"}</Tag></header>
    {access.role !== "viewer" && entry?.kind === "agent" &&
      <AgentPreview resource={entry} draft={entry.draft} published />}
    {access.role !== "viewer" && entry?.kind === "workflow" && <SharedWorkflow resourceId={entry.id} />}
    <Card title="应用内容" style={{ marginTop: 20 }}>
      <List dataSource={resources.filter((item) => item.kind !== "app")} renderItem={(item) =>
        <List.Item actions={access.role === "editor" ? [<Button key="edit" onClick={() => setSelected(item.id)}>
          编辑</Button>] : []}>
          <List.Item.Meta title={<Space>{item.name}<Tag>{labels[item.kind]}</Tag></Space>}
            description={item.description || "已加入此应用"} />
        </List.Item>} />
    </Card>
  </main>;
}
