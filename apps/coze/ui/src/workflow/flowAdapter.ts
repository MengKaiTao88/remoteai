import { MarkerType, type Connection, type Edge as FlowEdge } from "@xyflow/react";
import type { Edge, Graph } from "../types";
import { edgeId } from "./graphEditing";
import type { CanvasNode } from "./WorkflowNode";

export const toNodes = (graph: Graph, selected?: string): CanvasNode[] => graph.nodes.map((node) => ({
  id: node.id, type: "workflow", position: { x: node.x, y: node.y }, data: { node },
  selected: node.id === selected, ariaLabel: node.name,
}));

export const toEdges = (graph: Graph): FlowEdge[] => graph.edges.map((edge) => ({
  id: edgeId(edge), source: edge.source, target: edge.target, targetHandle: "input",
  sourceHandle: edge.port == null ? "output" : String(edge.port),
  label: edge.port == null ? undefined : edge.port ? "成立" : "不成立",
  markerEnd: { type: MarkerType.ArrowClosed, color: "#8979d8" },
  interactionWidth: 24, ariaLabel: `${edge.source} → ${edge.target}`,
}));

export function fromConnection(connection: Connection | FlowEdge): Edge {
  return { source: connection.source, target: connection.target,
    ...(["true", "false"].includes(connection.sourceHandle ?? "")
      ? { port: connection.sourceHandle === "true" } : {}) };
}
