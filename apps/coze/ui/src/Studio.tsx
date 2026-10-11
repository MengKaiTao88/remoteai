import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Dropdown, Empty, Input, Modal, Spin, Upload } from "antd";
import { Bot, BookOpen, Database, FileText, GitBranch, Plus, Search, Wrench, Boxes } from "lucide-react";
import { api, errorText } from "./api";
import { defaultDraft, labels, type Kind, type Resource } from "./types";
import { ResourceEditor } from "./ResourceEditor";
import { BackupButton } from "./projects/BackupButton";
import { TemplateLibrary } from "./projects/TemplateLibrary";
import { SharedAppView } from "./projects/SharedAppView";

const icons = { app: Boxes, agent: Bot, workflow: GitBranch, knowledge: BookOpen,
  prompt: FileText, table: Database, plugin: Wrench };
const kinds: Kind[] = ["app", "agent", "workflow", "knowledge", "prompt", "table", "plugin"];

export function Studio() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [selected, setSelected] = useState<Resource>();
  const [kind, setKind] = useState<Kind>("agent");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<Kind>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [access, setAccess] = useState<{ role: string; appId?: string }>();
  const refresh = useCallback(async () => {
    try { setResources(await api<Resource[]>("list_resources")); setError(""); }
    catch (error) { setError(errorText(error)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    let active = true;
    void api<{ role: string; appId?: string }>("access_info")
      .then((value) => { if (active) setAccess(value); })
      .catch((error: unknown) => { if (active) setError(errorText(error)); });
    return () => { active = false; };
  }, []);
  const saved = (resource: Resource) => {
    setSelected(resource);
    setResources((previous) => [resource, ...previous.filter((item) => item.id !== resource.id)]);
  };
  const create = async () => {
    if (!creating || !name.trim()) return;
    setBusy(true);
    try {
      const resource = await api<Resource>("save_resource", {
        kind: creating, name, description: "", draft: defaultDraft(creating),
      });
      setKind(creating); saved(resource); setCreating(undefined); setName("");
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };
  const filtered = resources.filter((item) => item.kind === kind
    && `${item.name} ${item.description}`.toLowerCase().includes(search.toLowerCase()));
  const navigate = (item: Kind) => {
    const go = () => { setKind(item); setSelected(undefined); setDirty(false); };
    if (dirty) Modal.confirm({ title: "放弃未保存的修改？", width: 400, onOk: go, okText: "放弃修改", cancelText: "继续编辑" });
    else go();
  };
  const importResource = async (file: File) => {
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error("请选择不超过 4 MB 的导出文件。");
      const value: unknown = JSON.parse(await file.text());
      if (value && typeof value === "object" && "format" in value && value.format === "remoteai-coze-template") {
        const template = await api<{id: string}>("save_template",value);
        const installed = await api<{entryId: string}>("install_template",{id:template.id});
        await refresh();
        const imported = await api<Resource>("get_resource",{id:installed.entryId});
        setKind(imported.kind); saved(imported); return;
      }
      if (!value || typeof value !== "object" || !("format" in value) || value.format !== "remoteai-coze"
        || !("resource" in value)) throw new Error("请选择从 Remote AI Coze 导出的文件。");
      const resource = value.resource as Resource;
      if (!kinds.includes(resource.kind)) throw new Error("文件中的内容类型暂不支持。");
      const imported = await api<Resource>("save_resource", { kind: resource.kind, name: resource.name,
        description: resource.description, draft: resource.draft });
      setKind(imported.kind); saved(imported);
    } catch (error) { setError(errorText(error)); }
  };
  if (!access) return <main className="studio-main">{error ? <Alert type="error" message={error} /> : <Spin />}</main>;
  if (access.role !== "owner") return <main className="studio-main">
    {error && <Alert type="error" message={error} />}
    <SharedAppView access={access} resources={resources} onSaved={saved} />
  </main>;
  return <div className="studio">
    <aside className="studio-nav"><div className="brand"><span>c</span><strong>coze</strong></div>
      <small>你的 AI 创作空间</small>
      {kinds.map((item) => {
        const Icon = icons[item];
        return <button key={item} className={kind === item ? "selected" : ""}
          onClick={() => navigate(item)}><Icon size={18} />{labels[item]}</button>;
      })}
      <div className="nav-note">保存在这台电脑<br />由 Remote AI 提供模型服务</div>
      <BackupButton onRestored={() => { setSelected(undefined); void refresh(); }} />
      <TemplateLibrary onInstalled={(id) => { void refresh();
        void api<Resource>("get_resource", { id }).then((resource) => { setKind(resource.kind); saved(resource); })
          .catch((error: unknown) => setError(errorText(error))); }} />
    </aside>
    <main className="studio-main">
      {error && <Alert type="error" message={error} closable onClose={() => setError("")} />}
      {selected ? <ResourceEditor key={selected.id} resource={selected} resources={resources}
        onSaved={saved} onDirty={setDirty} onBack={() => { setSelected(undefined); setDirty(false); void refresh(); }} /> : <>
        <header className="collection-header"><div><h1>{labels[kind]}</h1>
          <p>{kind === "knowledge" ? "让文件成为可检索、可引用的知识。" : "从想法出发，创建可以反复使用的 AI 能力。"}</p></div>
          <div className="collection-actions"><Upload accept=".json" showUploadList={false}
            beforeUpload={(file) => { void importResource(file); return false; }}><Button>导入</Button></Upload>
          <Dropdown menu={{ items: kinds.map((key) => ({ key, label: `新建${labels[key]}` })),
            onClick: ({ key }) => setCreating(key as Kind) }}>
            <Button type="primary" icon={<Plus size={16} />} onClick={() => setCreating(kind)}>新建{labels[kind]}</Button>
          </Dropdown>
          </div>
        </header>
        <Input className="resource-search" prefix={<Search size={16} />} placeholder="搜索名称或描述"
          value={search} onChange={(event) => setSearch(event.target.value)} allowClear />
        {loading ? <Spin /> : filtered.length === 0 ? <Empty description={`还没有${labels[kind]}`}>
          <Button onClick={() => setCreating(kind)}>创建第一个{labels[kind]}</Button></Empty> :
          <div className="resource-grid">{filtered.map((resource) => {
            const Icon = icons[resource.kind];
            return <button key={resource.id} className="resource-card" onClick={() => setSelected(resource)}>
              <div className="resource-icon"><Icon size={24} /></div><strong>{resource.name}</strong>
              <p>{resource.description || "添加描述，方便下次找到。"}</p>
              <small>{resource.mcpEnabled ? "已接入 Codex GUI" : "仅自己可见"}</small>
            </button>;
          })}</div>}
      </>}
    </main>
    <Modal title={`新建${creating ? labels[creating] : ""}`} open={Boolean(creating)} onCancel={() => setCreating(undefined)}
      onOk={() => void create()} confirmLoading={busy} okText="创建" cancelText="取消" width={400}>
      <Input autoFocus aria-label="名称" placeholder="给它起个名字" maxLength={100}
        value={name} onChange={(event) => setName(event.target.value)} onPressEnter={() => void create()} />
    </Modal>
  </div>;
}
