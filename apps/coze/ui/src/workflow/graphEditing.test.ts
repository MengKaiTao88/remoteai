import { describe, expect, it } from "vitest";
import { defaultGraph, type Graph } from "../types";
import { arrangeGraph, connectionError, edgeId, removeSelection } from "./graphEditing";
import { fromConnection, toEdges, toNodes } from "./flowAdapter";

const branch: Graph = { ...defaultGraph,
  nodes: [...defaultGraph.nodes, { id: "branch", type: "condition", name: "条件", x: 0, y: 0 }],
  edges: [{ source: "start", target: "branch" }, { source: "branch", target: "answer", port: true }],
};

describe("workflow connections", () => {
  it("allows both condition ports to reach the same target but rejects a duplicate port", () => {
    expect(connectionError(branch, { source: "branch", target: "answer", port: false })).toBeUndefined();
    expect(connectionError(branch, { source: "branch", target: "answer", port: true })).toContain("已经连接");
    expect(connectionError(branch, { source: "branch", target: "answer" })).toContain("分支");
    expect(connectionError(branch, { source: "answer", target: "end", port: false })).toContain("分支");
  });
  it("rejects self loops, cycles, incoming start and outgoing terminal connections", () => {
    expect(connectionError(branch, { source: "answer", target: "branch" })).toContain("回路");
    expect(connectionError(branch, { source: "answer", target: "answer" })).toBeDefined();
    expect(connectionError(branch, { source: "answer", target: "start" })).toBeDefined();
    for (const type of ["end", "break", "continue"]) {
      const graph = { ...branch, nodes: branch.nodes.map((node) => node.id === "end" ? { ...node, type } : node) };
      expect(connectionError(graph, { source: "end", target: "answer" })).toBeDefined();
    }
  });
  it("allows incomplete drafts and reconnection after excluding the old edge", () => {
    const graph = { ...defaultGraph, edges: defaultGraph.edges.slice(0, 1) };
    expect(connectionError(graph, { source: "start", target: "end" })).toBeUndefined();
  });
  it("round trips graph edges without saving rendering metadata", () => {
    expect(toEdges(branch).map(fromConnection)).toEqual(branch.edges);
    expect(toNodes(branch).map((node) => node.data.node)).toEqual(branch.nodes);
    expect(edgeId({ source: "a", target: "b", port: false })).not.toBe(edgeId({ source: "a", target: "b" }));
  });
  it("renders Rust-imported null ports as ordinary output handles", () => {
    const graph = { ...defaultGraph, edges: defaultGraph.edges.map((edge) => ({ ...edge, port: null })) };
    expect(toEdges(graph).every((edge) => edge.sourceHandle === "output" && edge.label === undefined)).toBe(true);
    expect(toEdges(graph).map(fromConnection)).toEqual(defaultGraph.edges);
    expect(edgeId(graph.edges[0])).toBe(edgeId(defaultGraph.edges[0]));
  });
});

it("removes attached edges while protecting start and the last end", () => {
  const removed = removeSelection(defaultGraph, defaultGraph.nodes.map((node) => node.id), []);
  expect(removed.nodes.map((node) => node.id)).toEqual(["start", "end"]);
  expect(removed.edges).toEqual([]);
  expect(removed.inputs).toEqual(defaultGraph.inputs);
  expect(removeSelection(defaultGraph, [], [edgeId(defaultGraph.edges[0])]).edges).toEqual([defaultGraph.edges[1]]);
});

it("arranges branches in order while preserving configuration and inputs", () => {
  const graph = arrangeGraph(branch);
  const position = (id: string) => graph.nodes.find((node) => node.id === id)!;
  expect(position("branch").x).toBeGreaterThan(position("start").x);
  expect(position("answer").x).toBeGreaterThan(position("branch").x);
  expect(position("answer").template).toBe("{{input.text}}");
  expect(new Set(graph.nodes.map((node) => `${node.x},${node.y}`)).size).toBe(graph.nodes.length);
  expect(graph.edges).toEqual(branch.edges);
  expect(graph.inputs).toEqual(branch.inputs);
});
