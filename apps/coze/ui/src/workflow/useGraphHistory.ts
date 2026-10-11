import { useRef, useState } from "react";
import type { Graph } from "../types";

const HISTORY_LIMIT = 100;

export function useGraphHistory(graph: Graph, onChange: (graph: Graph) => void) {
  const current = useRef(graph);
  current.current = graph;
  const [past, setPast] = useState<Graph[]>([]);
  const [future, setFuture] = useState<Graph[]>([]);
  const change = (next: Graph) => {
    const previous = current.current;
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    setPast((items) => [...items, previous].slice(-HISTORY_LIMIT));
    setFuture([]); current.current = next; onChange(next);
  };
  const undo = () => {
    const next = past.at(-1);
    if (!next) return;
    setPast(past.slice(0, -1)); setFuture([current.current, ...future]);
    current.current = next; onChange(next);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    setFuture(future.slice(1)); setPast([...past, current.current]);
    current.current = next; onChange(next);
  };
  return { change, undo, redo, canUndo: past.length > 0, canRedo: future.length > 0 };
}
