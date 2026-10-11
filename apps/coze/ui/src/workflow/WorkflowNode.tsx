import { Handle, Position, type Node as FlowNode, type NodeProps } from "@xyflow/react";
import { BookOpen, Bot, Braces, Flag, GitBranch, Play, Wrench } from "lucide-react";
import type { Node } from "../types";
import { isTerminal } from "./graphEditing";
import { nodeLabels } from "./nodes";

export type CanvasNode = FlowNode<{ node: Node }, "workflow">;

function nodeSummary(node: Node): string {
  if (node.type === "start") return "工作流的输入";
  if (node.type === "condition") return `${node.left ?? ""} · ${node.operator ?? "equal"} · ${node.right ?? ""}`;
  if (node.type === "llm" || node.type === "intent" || node.type === "nl2sql") {
    return String(node.model || "请选择模型");
  }
  if (node.type === "knowledge") return `已选择 ${Array.isArray(node.knowledge_ids) ? node.knowledge_ids.length : 0} 个知识库`;
  const content = node.template ?? node.prompt ?? node.query ?? node.value ?? node.url;
  return typeof content === "string" ? content : nodeLabels[node.type] ?? node.type;
}

export function WorkflowNode({ data, selected }: NodeProps<CanvasNode>) {
  const { node } = data;
  const icons = { start: Play, end: Flag, llm: Bot, knowledge: BookOpen, condition: GitBranch, code: Braces };
  const Icon = icons[node.type as keyof typeof icons] ?? Wrench;
  return <div className={`workflow-node ${selected ? "is-selected" : ""}`}>
    {node.type !== "start" && <Handle type="target" id="input" position={Position.Left}
      aria-label={`${node.name} 输入端口`} />}
    <header><span className={`node-icon node-icon-${node.type}`}><Icon size={16} /></span>
      <strong>{node.name}</strong><small>{nodeLabels[node.type]}</small></header>
    <p>{nodeSummary(node)}</p>
    {node.type === "condition" ? <div className="branch-ports">
      <div>条件成立<Handle type="source" id="true" position={Position.Right}
        aria-label={`${node.name} 条件成立端口`} /></div>
      <div>条件不成立<Handle type="source" id="false" position={Position.Right}
        aria-label={`${node.name} 条件不成立端口`} /></div>
    </div> : !isTerminal(node.type) && <Handle type="source" id="output" position={Position.Right}
      aria-label={`${node.name} 输出端口`} />}
  </div>;
}
