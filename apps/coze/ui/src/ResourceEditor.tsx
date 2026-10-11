import { useEffect, useState } from "react";
import { Alert, App, Button, Input, Popconfirm, Space, Tabs, Tag } from "antd";
import { ArrowLeft, Download, Save, Trash2 } from "lucide-react";
import { api, errorText } from "./api";
import type { Draft, Resource } from "./types";
import { KnowledgePanel } from "./knowledge/KnowledgePanel";
import { AgentEditor } from "./agents/AgentEditor";
import { WorkflowEditor } from "./workflow/WorkflowEditor";
import { TableEditor } from "./TableEditor";
import { ToolEditor } from "./ToolEditor";
import { DraftValidation, useDraftValidation } from "./draftValidation";
import { AppEditor } from "./projects/AppEditor";
import { ReleaseHistory } from "./projects/ReleaseHistory";
import { AccessPanel } from "./projects/AccessPanel";
import { ExternalToolsPanel } from "./external/ExternalToolsPanel";

interface Props {
  resource: Resource; resources: Resource[]; onSaved: (resource: Resource) => void;
  onBack: () => void; onDirty: (dirty: boolean) => void;
  manage?: boolean;
}

export function ResourceEditor({ resource, resources, onSaved, onBack, onDirty, manage = true }: Props) {
  const [name, setName] = useState(resource.name);
  const [description, setDescription] = useState(resource.description);
  const [draft, setDraft] = useState<Draft>(resource.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { message } = App.useApp();
  const validation = useDraftValidation();
  const dirty = name !== resource.name || description !== resource.description
    || JSON.stringify(draft) !== JSON.stringify(resource.draft);
  const modified = dirty || validation.invalid;
  useEffect(() => onDirty(modified), [modified, onDirty]);
  const save = async (): Promise<Resource> => {
    if (validation.invalid) throw new Error("请先修正标红的内容，再保存或运行。");
    const saved = await api<Resource>("save_resource", { id: resource.id, revision: resource.revision,
      kind: resource.kind, name, description, draft });
    onSaved(saved); return saved;
  };
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  const publish = () => perform(async () => {
    const current = dirty ? await save() : resource;
    onSaved(await api<Resource>("publish", { id: current.id, revision: current.revision, enabled: true }));
    void message.success("已发布，Codex GUI 现在可以调用了。");
  });
  const exportResource = () => perform(async () => {
    if (dirty) await save();
    const bundle = await api<unknown>("export_template", { id: resource.id });
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${name || "coze"}.json`; anchor.click(); URL.revokeObjectURL(url);
  });
  const back = <Button icon={<ArrowLeft size={16} />} onClick={modified ? undefined : onBack}>返回</Button>;
  const workflow = resource.kind === "workflow";
  const descriptionInput = <Input className="resource-description" aria-label="描述"
    placeholder="描述用途，帮助你和 AI 更好地使用它" value={description}
    maxLength={2000} onChange={(event) => setDescription(event.target.value)} />;
  return <DraftValidation.Provider value={validation.report}>
    <section className={`resource-editor ${workflow ? "workflow-resource" : ""}`}>
    <header className="editor-header"><Space>
      {modified ? <Popconfirm title="放弃未保存的修改？" onConfirm={onBack}
        styles={{ root: { maxWidth: 400 } }}>{back}</Popconfirm> : back}
      <Input aria-label="名称" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
      {resource.mcpEnabled && <Tag color="purple">Codex GUI</Tag>}
    </Space><Space>
      {manage && <Button aria-label="导出" icon={<Download size={16} />} disabled={validation.invalid || busy}
        onClick={() => void exportResource()} />}
      <Button icon={<Save size={16} />} loading={busy} disabled={!dirty || validation.invalid}
        onClick={() => void perform(async () => { await save(); void message.success("已保存"); })}>保存</Button>
      {manage && ["app", "agent", "workflow", "knowledge", "plugin", "table", "prompt"].includes(resource.kind) &&
        <Button type="primary" loading={busy} disabled={validation.invalid}
          onClick={() => void publish()}>发布到 Codex GUI</Button>}
    </Space></header>
    {error && <Alert type="error" message={error} closable onClose={() => setError("")} />}
    {!workflow && descriptionInput}
    <Tabs items={[{ key: "edit", label: "编辑与预览", children: <>
      {resource.kind === "app" && <AppEditor resource={resource} resources={resources}
        draft={draft} onChange={setDraft} save={dirty ? save : undefined} />}
      {resource.kind === "knowledge" && <KnowledgePanel resource={resource} />}
      {resource.kind === "agent" && <AgentEditor resource={resource} resources={resources} draft={draft}
        onChange={setDraft} save={dirty ? save : undefined} />}
      {resource.kind === "workflow" && <WorkflowEditor resource={resource} resources={resources} draft={draft}
        onChange={setDraft} save={dirty || validation.invalid ? save : undefined} />}
      {resource.kind === "prompt" && <Input.TextArea value={String(draft.text ?? "")} rows={20}
        placeholder="写下可反复使用的提示词…" onChange={(event) => setDraft({ text: event.target.value })} />}
      {resource.kind === "table" && <TableEditor resource={resource} />}
      {resource.kind === "plugin" && <ToolEditor resource={resource} draft={draft} onChange={setDraft}
        save={dirty || validation.invalid ? save : undefined} />}
    </> }, ...(manage ? [{ key: "settings", label: "设置", children: <div className="settings-panel">
      {workflow && <><h3>用途描述</h3>{descriptionInput}</>}
      <h3>保存为模板</h3><p>将当前配置和引用的内容一起放入模板广场，方便复用或导出分享。</p>
      <Button disabled={modified} onClick={() => void perform(async () => {
        const bundle = await api<unknown>("export_template", { id: resource.id });
        await api("save_template", bundle); void message.success("已保存到模板广场");
      })}>保存到模板广场</Button>
      <h3>发布状态</h3><p>当前草稿版本：{resource.revision}　已发布版本：{resource.publishedRevision ?? "尚未发布"}</p>
      <ReleaseHistory resource={resource} onSaved={onSaved} />
      {resource.kind === "app" && <AccessPanel appId={resource.id} published={Boolean(resource.publishedRevision)} />}
      <ExternalToolsPanel resource={resource} />
      {resource.mcpEnabled && <Button onClick={() => void perform(async () => {
        onSaved(await api<Resource>("publish", { id: resource.id, revision: resource.revision, enabled: false }));
      })}>停止向 Codex GUI 提供</Button>}
      <h3>删除内容</h3><p>删除后将同时移除相关文档、对话和运行记录。</p>
      <Popconfirm title="确定删除？此操作无法撤销。" overlayStyle={{ maxWidth: 400 }} onConfirm={() => perform(async () => {
        await api("delete_resource", { id: resource.id, revision: resource.revision }); onBack();
      })}><Button danger icon={<Trash2 size={16} />}>删除</Button></Popconfirm>
    </div> }] : [])]} />
  </section></DraftValidation.Provider>;
}
