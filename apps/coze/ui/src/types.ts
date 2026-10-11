export type Kind = "app" | "agent" | "workflow" | "knowledge" | "prompt" | "table" | "plugin";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Draft = Record<string, Json>;
export interface Resource {
  id: string; kind: Kind; name: string; description: string; draft: Draft; revision: number;
  publishedRevision: number | null; mcpEnabled: boolean; updatedAt: string;
}
export interface Document { id: string; name: string; chunks: number; bytes: number; createdAt: string }
export interface Citation { chunkId: string; documentName: string; text: string; score: number }
export interface Message { role: string; content: string; citations: Citation[] }
export interface Model { id: string; name: string }
export const labels: Record<Kind, string> = {
  app: "应用",
  agent: "智能体", workflow: "工作流", knowledge: "知识库", prompt: "提示词", table: "数据表", plugin: "工具",
};

export interface Node {
  id: string; name: string; x: number; y: number; type: string; [key: string]: Json;
}
export interface Edge { source: string; target: string; port?: boolean | null }
export interface InputField { name: string; description: string; kind: string; required: boolean }
export interface Graph { nodes: Node[]; edges: Edge[]; inputs?: InputField[] }

export const defaultGraph: Graph = {
  inputs: [{ name: "text", description: "要处理的文本", kind: "string", required: true }],
  nodes: [
    { id: "start", name: "开始", type: "start", x: 30, y: 70 },
    { id: "answer", name: "文本处理", type: "template", template: "{{input.text}}", x: 300, y: 70 },
    { id: "end", name: "结束", type: "end", value: "{{answer.output}}", x: 570, y: 70 },
  ],
  edges: [{ source: "start", target: "answer" }, { source: "answer", target: "end" }],
};

export function defaultDraft(kind: Kind): Draft {
  switch (kind) {
    case "app": return { entryId: "", resourceIds: [] };
    case "agent": return { model: "", prompt: "你是一位耐心、准确的助手。", knowledgeIds: [], temperature: 0.7 };
    case "workflow": return JSON.parse(JSON.stringify(defaultGraph)) as Draft;
    case "knowledge": return {};
    case "prompt": return { text: "" };
    case "table": return { columns: ["名称", "内容"] };
    case "plugin": return { url: "https://", method: "GET", body: {} };
  }
}
