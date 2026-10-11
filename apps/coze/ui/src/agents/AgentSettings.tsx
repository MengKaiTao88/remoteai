import { useEffect, useState } from "react";
import { Alert, Button, Input, InputNumber, Select, Slider, Space } from "antd";
import { api, errorText } from "../api";
import type { Draft, Model, Resource } from "../types";

interface Props { resources: Resource[]; draft: Draft; onChange: (draft: Draft) => void }

export function AgentSettings({ resources, draft, onChange }: Props) {
  const [models, setModels] = useState<Model[]>([]);
  const [error, setError] = useState("");
  const refresh = () => api<Model[]>("models").then(setModels)
    .catch((error: unknown) => setError(errorText(error)));
  useEffect(() => { void refresh(); }, []);
  const update = (key: string, value: Draft[string]) => onChange({ ...draft, [key]: value });
  const toolIds = (draft.toolIds ?? []) as string[];
  const available = resources.filter((item) => ["workflow", "plugin", "knowledge", "table"].includes(item.kind));
  return <section className="panel"><h2>角色与能力</h2>
    {error && <Alert type="error" message={error} closable onClose={() => setError("")} />}
    <label>模型</label><Space.Compact block>
      <Select className="grow" showSearch value={String(draft.model || "") || undefined}
        placeholder="选择 Remote AI 的模型" options={models.map((model) => ({ value: model.id, label: model.name }))}
        onChange={(value) => update("model", value)} />
      <Button onClick={() => void refresh()}>刷新</Button>
    </Space.Compact>
    <label>角色提示词</label><Input.TextArea rows={9} value={String(draft.prompt ?? "")}
      onChange={(event) => update("prompt", event.target.value)} placeholder="描述它的角色、任务和回答方式…" />
    <Select className="full" placeholder="从提示词库插入" value={undefined}
      options={resources.filter((item) => item.kind === "prompt").map((item) => ({ value: item.id, label: item.name }))}
      onChange={(id) => update("prompt", `${String(draft.prompt ?? "")}\n${String(
        resources.find((item) => item.id === id)?.draft.text ?? "")}`)} />
    <label>回答前参考的知识库</label><Select mode="multiple" className="full" placeholder="选择知识库"
      value={(draft.knowledgeIds ?? []) as string[]} onChange={(value) => update("knowledgeIds", value)}
      options={resources.filter((item) => item.kind === "knowledge").map((item) => ({ value: item.id, label: item.name }))} />
    <label>可自主调用的工具</label><Select mode="multiple" className="full" placeholder="选择已发布的工作流、工具或资料"
      value={toolIds} onChange={(value: string[]) => onChange({ ...draft, toolIds: value,
        writableTableIds: ((draft.writableTableIds ?? []) as string[]).filter((id) => value.includes(id)) })}
      options={available.map((item) => ({ value: item.id, label: `${item.name}${item.publishedRevision ? "" : "（未发布）"}`,
        disabled: !item.publishedRevision }))} />
    <label>允许修改的数据表</label><Select mode="multiple" className="full" placeholder="默认仅允许查询"
      value={(draft.writableTableIds ?? []) as string[]} onChange={(value) => update("writableTableIds", value)}
      options={available.filter((item) => item.kind === "table" && toolIds.includes(item.id))
        .map((item) => ({ value: item.id, label: item.name }))} />
    <Space wrap><div><label>最多调用轮数</label><InputNumber min={1} max={20} value={Number(draft.maxSteps ?? 8)}
      onChange={(value) => update("maxSteps", value ?? 8)} /></div>
      <div><label>记住最近对话轮数</label><InputNumber min={0} max={40} value={Number(draft.memoryTurns ?? 20)}
        onChange={(value) => update("memoryTurns", value ?? 20)} /></div></Space>
    <label>回答创造性</label><Slider min={0} max={2} step={0.1} value={Number(draft.temperature ?? 0.7)}
      onChange={(value) => update("temperature", value)} />
  </section>;
}
