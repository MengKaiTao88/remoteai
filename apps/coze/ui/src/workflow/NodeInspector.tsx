import { useEffect, useState } from "react";
import { Button, Checkbox, Input, InputNumber, Select } from "antd";
import { X } from "lucide-react";
import type { Graph, Json, Model, Node, Resource } from "../types";
import { nodeLabels } from "./nodes";
import { useInvalidField } from "../draftValidation";
import { ConnectionEditor } from "./ConnectionEditor";
import { isTerminal, removeSelection } from "./graphEditing";

interface Props {
  node: Node; graph: Graph; resources: Resource[]; models: Model[];
  onChange: (graph: Graph) => void; onClose: () => void;
}

export function NodeInspector({ node, graph, resources, models, onChange, onClose }: Props) {
  const update = (key: string, value: Json) => onChange({ ...graph,
    nodes: graph.nodes.map((item) => item.id === node.id ? { ...item, [key]: value } : item) });
  const text = (key: string, label: string, rows = 3) => <label key={key}>{label}
    <Input.TextArea value={String(node[key] ?? "")} rows={rows} onChange={(event) => update(key, event.target.value)} />
  </label>;
  const json = (key: string, label: string) => <JsonInput key={`${node.id}-${key}`} label={label}
    value={node[key]} onChange={(value) => update(key, value)} />;
  const workflows = resources.filter((item) => item.kind === "workflow").map((item) => ({ value: item.id, label: item.name }));
  return <aside className="node-inspector"><header><h3>{nodeLabels[node.type]}</h3>
    <Button type="text" aria-label="关闭节点配置" icon={<X size={16} />} onClick={onClose} /></header>
    <label>名称<Input value={node.name} onChange={(event) => update("name", event.target.value)} /></label>
    <small>引用输入：<code>{"{{input.text}}"}</code><br />此节点结果：<code>{`{{${node.id}.output}}`}</code></small>
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
    </label>{text("system", "角色提示词")}{text("prompt", "用户提示词", 6)}
      <label>随机性<InputNumber min={0} max={2} step={0.1} value={Number(node.temperature ?? 0.7)}
        onChange={(value) => update("temperature", value ?? 0.7)} /></label></>}
    {node.type === "intent" && <><label>模型<Select className="full" value={String(node.model || "") || undefined}
      options={models.map((model) => ({ value: model.id, label: model.name }))} onChange={(value) => update("model", value)} />
      </label>{text("query", "待识别内容")}{json("intents", "候选意图")}
      <small>结果中的 intent 为匹配的意图；无法匹配时返回“其他”。</small></>}
    {node.type === "template" && text("template", "文本模板", 8)}
    {node.type === "input" && <>{text("prompt", "提问内容")}{json("fields", "需要填写的内容")}
      {json("choices", "可选回答（留空表示自由填写）")}</>}
    {node.type === "output" && json("value", "输出消息")}
    {node.type === "variable" && <>{text("variable_name", "变量名称", 1)}{json("value", "变量内容")}
      <small>后续节点可通过 <code>{"{{variables.变量名称}}"}</code> 读取。</small></>}
    {node.type === "aggregate" && <>{json("values", "按优先顺序填写候选值")}
      <small>采用首个已生成且非空的值，可合并不同分支的结果。</small></>}
    {node.type === "aggregate_groups" && json("groups", "分组名称与候选值")}
    {node.type === "conversation" && <><label>操作<Select className="full" value={String(node.operation)}
      onChange={(value) => update("operation", value)} options={[
        { value: "create", label: "创建会话" }, { value: "list", label: "会话列表" },
        { value: "rename", label: "重命名会话" }, { value: "delete", label: "删除会话" },
        { value: "history", label: "查询消息" }, { value: "append", label: "添加消息" },
        { value: "edit_message", label: "修改消息" }, { value: "delete_message", label: "删除消息" },
        { value: "clear", label: "清空消息" },
      ]} /></label>{json("input", "操作内容")}
      <small>创建时填写 title；查询时填写 conversationId；添加消息还需 role 和 content。</small></>}
    {node.type.startsWith("table_") && <><label>数据表<Select className="full" value={String(node.table_id || "") || undefined}
      options={resources.filter((item) => item.kind === "table").map((item) => ({ value: item.id, label: item.name }))}
      onChange={(value) => update("table_id", value)} /></label>
      {node.type === "table_query" && json("filter", "匹配字段（JSON）")}
      {node.type === "table_write" && json("value", "记录内容（JSON）")}
      {node.type === "table_update" && <>{text("row_id", "记录 ID", 2)}{json("value", "更新后的完整记录")}</>}
      {node.type === "table_delete" && text("row_id", "记录 ID", 2)}</>}
    {(node.type === "sql" || node.type === "nl2sql") && <><label>数据表<Select mode="multiple"
      className="full" value={node.table_ids as string[]} onChange={(value) => update("table_ids", value)}
      options={resources.filter((item) => item.kind === "table").map((item) => ({ value: item.id, label: item.name }))} />
      </label>{node.type === "sql" ? text("sql", "查询语句", 8) : <>
        <label>模型<Select className="full" value={String(node.model || "") || undefined}
          options={models.map((model) => ({ value: model.id, label: model.name }))}
          onChange={(value) => update("model", value)} /></label>{text("question", "查询要求", 4)}</>}
      <small>按选择顺序使用 t1、t2 等表名。仅查询所选数据表。</small></>}
    {node.type === "plugin" && <><label>工具<Select className="full" value={String(node.plugin_id || "") || undefined}
      options={resources.filter((item) => item.kind === "plugin").map((item) => ({ value: item.id, label: item.name }))}
      onChange={(value) => update("plugin_id", value)} /></label>{json("input", "调用参数（JSON）")}</>}
    {node.type === "code" && <><label>语言<Select className="full" value={String(node.language || "javascript")}
      options={[{ value: "javascript", label: "JavaScript" }, { value: "typescript", label: "TypeScript" },
        { value: "python", label: "Python" }]} onChange={(value) => update("language", value)} /></label>
      {node.language !== "python" && <Checkbox checked={Boolean(node.entrypoint)}
        onChange={(event) => update("entrypoint", event.target.checked)}>使用 main 函数</Checkbox>}
      {json("input", "输入（JSON）")}{text("code", "代码", 12)}
      <small>{node.language === "python" ? "在 main(args) 中用 args.params 读取输入，再返回处理结果。"
        : node.entrypoint ? "在 main(args) 中用 args.params 读取输入，再返回处理结果。"
          : "使用 input 读取输入，用 return 返回结果。"}仅支持数据处理，不支持网络和文件操作。</small></>}
    {node.type === "end" && json("value", "输出内容（JSON）")}
    {node.type === "knowledge" && <><label>知识库<Select className="full" mode="multiple"
      value={node.knowledge_ids as string[]} options={resources.filter((item) => item.kind === "knowledge")
        .map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => update("knowledge_ids", value)} /></label>
      {text("query", "检索问题")}<label>结果数量<InputNumber min={1} max={20} value={Number(node.limit)}
        onChange={(value) => update("limit", value ?? 6)} /></label></>}
    {(node.type === "knowledge_write" || node.type === "knowledge_delete") && <><label>知识库<Select
      className="full" value={String(node.knowledge_id || "") || undefined}
      options={resources.filter((item) => item.kind === "knowledge").map((item) => ({ value: item.id, label: item.name }))}
      onChange={(value) => update("knowledge_id", value)} /></label>
      {node.type === "knowledge_write" ? <>{text("document_name", "文档名称", 1)}{text("text", "文档内容", 6)}</>
        : json("document_ids", "要删除的文档 ID 列表")}</>}
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
    {["subworkflow", "loop", "repeat"].includes(node.type) && <><label>工作流<Select className="full"
      value={String(node.workflow_id || "") || undefined} options={workflows}
      onChange={(value) => update("workflow_id", value)} /></label>
      {node.type === "loop" && json("items", "待处理列表（JSON）")}
      {node.type === "repeat" && json("count", "循环次数")}
      {node.type === "subworkflow" && json("input", "输入（JSON）")}
      {node.type !== "subworkflow" && <small>循环内可读取 input.item、input.index 和 variables 中的变量。</small>}</>}
    {["break", "continue"].includes(node.type) && <small>用于循环体工作流，在当前分支到达此处时立即生效。</small>}
    {!isTerminal(node.type) && <ConnectionEditor node={node} graph={graph} onChange={onChange} />}
    {node.type !== "start" && <Button danger disabled={node.type === "end"
      && graph.nodes.filter((item) => item.type === "end").length === 1}
      onClick={() => { onChange(removeSelection(graph, [node.id], [])); onClose(); }}>删除节点</Button>}
  </aside>;
}

function JsonInput({ value, onChange, label }: { value: Json; onChange: (value: Json) => void; label: string }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText((current) => {
      try { if (JSON.stringify(JSON.parse(current)) === JSON.stringify(value)) return current; }
      catch { /* An external undo replaces unfinished JSON as well as valid values. */ }
      return JSON.stringify(value, null, 2);
    });
    setInvalid(false);
  }, [value]);
  useInvalidField(invalid);
  return <label>{label}<Input.TextArea rows={3} value={text} status={invalid ? "error" : undefined}
    onChange={(event) => {
      const next = event.target.value; setText(next);
      try { onChange(JSON.parse(next) as Json); setInvalid(false); } catch { setInvalid(true); }
    }} />{invalid && <small className="error-text">请填写有效的 JSON。</small>}</label>;
}
