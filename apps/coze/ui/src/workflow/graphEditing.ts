import type { Edge, Graph } from "../types";

export const MAX_NODES = 200;
const MAX_EDGES = 800;
export const isTerminal = (type: string) => ["end", "break", "continue"].includes(type);
export const edgeId = (edge: Edge) => JSON.stringify([edge.source, edge.target, edge.port ?? null]);

/** Drafts may be disconnected; only reject connections that cannot become executable. */
export function connectionError(graph: Graph, edge: Edge): string | undefined {
  const source = graph.nodes.find((node) => node.id === edge.source);
  const target = graph.nodes.find((node) => node.id === edge.target);
  if (!source || !target) return "请连接画布中的节点。";
  if (source.id === target.id) return "不能连接节点自身。";
  if (target.type === "start" || isTerminal(source.type)) return "请从输出端口连接到输入端口。";
  if ((source.type === "condition") !== (typeof edge.port === "boolean")) return "请选择条件分支。";
  if (graph.edges.some((item) => edgeId(item) === edgeId(edge))) return "这两个端口已经连接。";
  if (graph.edges.length >= MAX_EDGES) return "连线数量已达到上限。";
  const pending = [target.id];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === source.id) return "这条连线会形成回路，请使用循环节点。";
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...graph.edges.filter((item) => item.source === id).map((item) => item.target));
  }
  return undefined;
}

export function removeSelection(graph: Graph, nodes: string[], edges: string[]): Graph {
  const removable = new Set(nodes);
  const ends = graph.nodes.filter((node) => node.type === "end");
  // Keep the unique start and at least one end, even when selecting the whole canvas.
  graph.nodes.filter((node) => node.type === "start").forEach((node) => removable.delete(node.id));
  if (ends.length && ends.every((node) => removable.has(node.id))) removable.delete(ends[0].id);
  return { ...graph, nodes: graph.nodes.filter((node) => !removable.has(node.id)),
    edges: graph.edges.filter((edge) => !removable.has(edge.source) && !removable.has(edge.target)
      && !edges.includes(edgeId(edge))) };
}

/** Stable left-to-right layering, including temporarily disconnected draft nodes. */
export function arrangeGraph(graph: Graph): Graph {
  const remaining = new Set(graph.nodes.map((node) => node.id));
  const levels = new Map<string, number>();
  while (remaining.size) {
    const ready = [...remaining].filter((id) => !graph.edges.some((edge) => edge.target === id
      && remaining.has(edge.source)));
    if (!ready.length) break;
    for (const id of ready) {
      const parents = graph.edges.filter((edge) => edge.target === id);
      levels.set(id, Math.max(0, ...parents.map((edge) => (levels.get(edge.source) ?? 0) + 1)));
      remaining.delete(id);
    }
  }
  const rows = new Map<number, number>();
  return { ...graph, nodes: graph.nodes.map((node) => {
    const level = levels.get(node.id) ?? 0;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    return { ...node, x: 60 + level * 340, y: 60 + row * 180 };
  }) };
}
