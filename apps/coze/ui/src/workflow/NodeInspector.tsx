import { useState } from "react";
import { Button, Checkbox, Input, InputNumber, Select } from "antd";
import type { Graph, Json, Model, Node, Resource } from "../types";
import { nodeLabels } from "./nodes";
import { useInvalidField } from "../draftValidation";

interface Props { node: Node; graph: Graph; resources: Resource[]; models: Model[]; onChange: (graph: Graph) => void }

export function NodeInspector({ node, graph, resources, models, onChange }: Props) {
  const [target, setTarget] = useState<string>();
  const [port, setPort] = useState(true);
  const update = (key: string, value: Json) => onChange({ ...graph,
    nodes: graph.nodes.map((item) => item.id === node.id ? { ...item, [key]: value } : item) });
  const text = (key: string, label: string, rows = 3) => <label key={key}>{label}
    <Input.TextArea value={String(node[key] ?? "")} rows={rows} onChange={(event) => update(key, event.target.value)} />
  </label>;
  const json = (key: string, label: string) => <JsonInput key={`${node.id}-${key}`} label={label}
    value={node[key]} onChange={(value) => update(key, value)} />;
  const workflows = resources.filter((item) => item.kind === "workflow").map((item) => ({ value: item.id, label: item.name }));
  return <aside className="node-inspector"><h3>{nodeLabels[node.type]}</h3>
    <label>名称<Input value={node.name} onChange={(event) => update("name", event.target.value)} /></label>
    <small>引用输入：<code>{"{{input.text}}"}</code><br />引用节点结果：<code>{"{{节点ID.output}}"}</code></small>
    {node.type === "start" && <><h4>输入参数</h4>{(graph.inputs ?? []).map((field, index) => <div key={index}>
      <Input aria-label="参数名" placeholder="参数名" value={field.name} onChange={(event) => onChange({ ...graph,
        inputs: graph.inputs?.map((item, cursor) => cursor === index ? { ...item, name: event.target.value } : item) })} />
      <Input aria-label="参数说明" placeholder="说明" value={field.description} onChange={(event) => onChange({ ...graph,
        inputs: graph.inputs?.map((item, cursor) => cursor === index ? { ...item, description: event.target.value } : item) })} />
      <Select className="full" value={field.kind} options={["string", "number", "integer", "boolean", "object", "array"]
        .map((value) => ({ value }))} onChange={(kind) => onChange({ ...graph,
          inputs: graph.inputs?.map((item, cursor) => cursor === index ? { ...item, kind } : item) })} />
      <Checkbox checked={field.required} onChange={(event) => onChange({ ...graph,
        inputs: graph.inputs?.map((item, cursor) => cursor === index ? { ...item, required: event.target.checked } : item) })}>
        必填</Checkbox><Button type="text" danger onClick={() => onChange({ ...graph,
          inputs: graph.inputs?.filter((_, cursor) => cursor !== index) })}>移除</Button>
    </div>)}<Button onClick={() => onChange({ ...graph, inputs: [...(graph.inputs ?? []), {
      name: `input${(graph.inputs?.length ?? 0) + 1}`, description: "", kind: "string", required: false,
    }] })}>添加参数</Button></>}
    {node.type === "llm" && <><label>模型<Select className="full" showSearch value={String(node.model || "") || undefined}
      options={models.map((model) => ({ value: model.id, label: model.name }))} onChange={(value) => update("model", value)} />
    </label>{text("system", "角色提示词")}{text("prompt", "用户提示词", 6)}</>}
    {node.type === "template" && text("template", "文本模板", 8)}
    {node.type.startsWith("table_") && <><label>数据表<Select className="full" value={String(node.table_id || "") || undefined}
      options={resources.filter((item) => item.kind === "table").map((item) => ({ value: item.id, label: item.name }))}
      onChange={(value) => update("table_id", value)} /></label>
      {node.type === "table_query" && json("filter", "匹配字段（JSON）")}
      {node.type === "table_write" && json("value", "记录内容（JSON）")}
      {node.type === "table_delete" && text("row_id", "记录 ID", 2)}</>}
    {node.type === "plugin" && <><label>工具<Select className="full" value={String(node.plugin_id || "") || undefined}
      options={resources.filter((item) => item.kind === "plugin").map((item) => ({ value: item.id, label: item.name }))}
      onChange={(value) => update("plugin_id", value)} /></label>{json("input", "调用参数（JSON）")}</>}
    {node.type === "code" && <>{json("input", "输入（JSON）")}{text("code", "JavaScript", 12)}
      <small>使用 input 读取输入，用 return 返回结果。支持数据处理，不支持网络和文件操作。</small></>}
    {node.type === "end" && json("value", "输出内容（JSON）")}
    {node.type === "knowledge" && <><label>知识库<Select className="full" mode="multiple"
      value={node.knowledge_ids as string[]} options={resources.filter((item) => item.kind === "knowledge")
        .map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => update("knowledge_ids", value)} /></label>
      {text("query", "检索问题")}<label>结果数量<InputNumber min={1} max={20} value={Number(node.limit)}
        onChange={(value) => update("limit", value ?? 6)} /></label></>}
    {node.type === "condition" && <>{json("left", "比较值（JSON）")}
      <label>条件<Select className="full" value={String(node.operator)} onChange={(value) => update("operator", value)}
        options={[{ value: "equal", label: "等于" }, { value: "not_equal", label: "不等于" },
          { value: "contains", label: "包含" }, { value: "greater", label: "大于" },
          { value: "less", label: "小于" }, { value: "empty", label: "为空" }]} /></label>{json("right", "目标值（JSON）")}</>}
    {node.type === "http" && <>{text("url", "HTTPS 地址", 2)}<label>请求方式<Select className="full"
      value={String(node.method)} options={["GET", "POST", "PUT", "DELETE"].map((value) => ({ value }))}
      onChange={(value) => update("method", value)} /></label>{json("body", "请求内容（JSON）")}</>}
    {node.type === "json_parse" && text("text", "待解析文本")}
    {node.type === "json_stringify" && json("value", "待转换内容（JSON）")}
    {(node.type === "subworkflow" || node.type === "loop") && <><label>工作流<Select className="full"
      value={String(node.workflow_id || "") || undefined} options={workflows}
      onChange={(value) => update("workflow_id", value)} /></label>
      {node.type === "loop" ? json("items", "待处理列表（JSON）") : json("input", "输入（JSON）")}</>}
    {node.type !== "end" && <div className="connection-controls"><h4>下一步</h4>
      {node.type === "condition" && <Select className="full" value={String(port)}
        options={[{ value: "true", label: "条件成立" }, { value: "false", label: "条件不成立" }]}
        onChange={(value) => setPort(value === "true")} />}
      <Select className="full" placeholder="选择要连接的节点" value={target} onChange={setTarget}
        options={graph.nodes.filter((item) => item.id !== node.id && item.type !== "start")
          .map((item) => ({ value: item.id, label: item.name }))} />
      <Button disabled={!target} onClick={() => {
        if (!target || graph.edges.some((edge) => edge.source === node.id && edge.target === target)) return;
        onChange({ ...graph, edges: [...graph.edges, { source: node.id, target,
          ...(node.type === "condition" ? { port } : {}) }] }); setTarget(undefined);
      }}>连接</Button>
      {graph.edges.filter((edge) => edge.source === node.id).map((edge) => <Button key={`${edge.target}-${edge.port}`}
        type="text" danger onClick={() => onChange({ ...graph, edges: graph.edges.filter((item) => item !== edge) })}>
        移除 → {graph.nodes.find((node) => node.id === edge.target)?.name}</Button>)}
    </div>}
    {node.type !== "start" && <Button danger onClick={() => onChange({
      ...graph,
      nodes: graph.nodes.filter((item) => item.id !== node.id),
      edges: graph.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id),
    })}>删除节点</Button>}
  </aside>;
}

function JsonInput({ value, onChange, label }: { value: Json; onChange: (value: Json) => void; label: string }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  useInvalidField(invalid);
  return <label>{label}<Input.TextArea rows={3} value={text} status={invalid ? "error" : undefined}
    onChange={(event) => {
      const next = event.target.value; setText(next);
      try { onChange(JSON.parse(next) as Json); setInvalid(false); } catch { setInvalid(true); }
    }} />{invalid && <small className="error-text">请填写有效的 JSON。</small>}</label>;
}
