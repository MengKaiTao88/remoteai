import type { Json, Node } from "../types";

export const nodeLabels: Record<string, string> = {
  start: "开始", end: "结束", llm: "大模型", knowledge: "知识检索", template: "文本处理",
  condition: "条件分支", http: "HTTP 请求", json_parse: "解析 JSON", json_stringify: "生成 JSON",
  subworkflow: "子工作流", loop: "批量执行",
  code: "代码",
  input: "等待用户输入", output: "输出消息", variable: "设置变量", aggregate: "合并分支变量",
  aggregate_groups: "分组合并变量", conversation: "会话与消息",
  sql: "SQL 查询", nl2sql: "自然语言生成 SQL",
  intent: "意图识别", knowledge_write: "写入知识库", knowledge_delete: "删除知识文档",
  table_update: "更新数据", repeat: "按次数循环", break: "终止循环", continue: "继续下次循环",
  plugin: "工具调用", table_query: "查询数据", table_write: "写入数据", table_delete: "删除数据",
};

export function newNode(type: string, index: number): Node {
  const config: Record<string, Record<string, Json>> = {
    input: { prompt: "请补充以下信息。", fields: [{ name: "answer", description: "回答", kind: "string", required: true }], choices: [] },
    output: { value: "{{input.text}}" }, variable: { variable_name: "result", value: "{{input.text}}" },
    aggregate: { values: ["{{input.text}}"] }, aggregate_groups: { groups: { result: ["{{input.text}}"] } },
    conversation: { operation: "create", input: { title: "新的会话" } },
    sql: { table_ids: [], sql: "SELECT * FROM t1 LIMIT 100" },
    nl2sql: { table_ids: [], model: "", question: "{{input.text}}" },
    intent: { model: "", query: "{{input.text}}", intents: ["咨询", "反馈"] },
    knowledge_write: { knowledge_id: "", document_name: "新的文档", text: "{{input.text}}" },
    knowledge_delete: { knowledge_id: "", document_ids: [] },
    table_update: { table_id: "", row_id: "{{input.id}}", value: "{{input.value}}" },
    repeat: { workflow_id: "", count: 3 }, break: {}, continue: {},
    code: { code: "return { result: input.text };", input: "{{input}}", language: "javascript", entrypoint: false },
    plugin: { plugin_id: "", input: "{{input}}" },
    table_query: { table_id: "", filter: {} }, table_write: { table_id: "", value: "{{input}}" },
    table_delete: { table_id: "", row_id: "{{input.id}}" },
    llm: { model: "", prompt: "{{input.text}}", system: "", temperature: 0.7 },
    knowledge: { knowledge_ids: [], query: "{{input.text}}", limit: 6 },
    template: { template: "{{input.text}}" },
    condition: { left: "{{input.text}}", right: "", operator: "equal" },
    http: { url: "https://", method: "GET", body: {} },
    json_parse: { text: "{{input.text}}" }, json_stringify: { value: "{{input}}" },
    subworkflow: { workflow_id: "", input: "{{input}}" },
    loop: { workflow_id: "", items: "{{input.items}}" }, end: { value: "{{input}}" },
  };
  return { id: `node_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, name: nodeLabels[type],
    x: 40 + (index % 4) * 250, y: 220 + Math.floor(index / 4) * 140, type, ...config[type] };
}
