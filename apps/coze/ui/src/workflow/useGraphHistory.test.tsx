// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { defaultGraph, type Graph } from "../types";
import { useGraphHistory } from "./useGraphHistory";

it("undoes a complete gesture and restores parameters, edges and redo invalidation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  let history!: ReturnType<typeof useGraphHistory>;
  let graph!: Graph;
  function Fixture() {
    const [value, setValue] = useState(defaultGraph);
    graph = value; history = useGraphHistory(value, setValue); return null;
  }
  try {
    await act(async () => root.render(<Fixture />));
    await act(async () => history.change({ ...graph, edges: [] }));
    await act(async () => history.change({ ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, x: node.x + 100 })) }));
    await act(async () => history.undo());
    expect(graph.nodes).toEqual(defaultGraph.nodes);
    expect(graph.edges).toEqual([]);
    await act(async () => history.undo());
    expect(graph).toEqual(defaultGraph);
    await act(async () => history.redo());
    expect(graph.edges).toEqual([]);
    await act(async () => history.change({ ...graph, inputs: [] }));
    expect(history.canRedo).toBe(false);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
