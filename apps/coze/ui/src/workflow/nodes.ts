import type { Json, Node } from "../types";

export const nodeLabels: Record<string, string> = {
  start: "开始", end: "结束", llm: "大模型", knowledge: "知识检索", template: "文本处理",
  condition: "条件分支", http: "HTTP 请求", json_parse: "解析 JSON", json_stringify: "生成 JSON",
  subworkflow: "子工作流", loop: "批量执行",
  code: "代码",
  plugin: "工具调用", table_query: "查询数据", table_write: "写入数据", table_delete: "删除数据",
};

export function newNode(type: string, index: number): Node {
  const config: Record<string, Record<string, Json>> = {
    code: { code: "return { result: input.text };", input: "{{input}}" },
    plugin: { plugin_id: "", input: "{{input}}" },
    table_query: { table_id: "", filter: {} }, table_write: { table_id: "", value: "{{input}}" },
    table_delete: { table_id: "", row_id: "{{input.id}}" },
    llm: { model: "", prompt: "{{input.text}}", system: "" },
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
