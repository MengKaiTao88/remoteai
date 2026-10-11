import { useRef, type PointerEvent } from "react";
import type { Graph, Node } from "../types";
import { nodeLabels } from "./nodes";

interface Props { graph: Graph; selected?: string; onSelect: (id: string) => void; onChange: (graph: Graph) => void }
const WIDTH = 195;
const HEIGHT = 80;

export function Canvas({ graph, selected, onSelect, onChange }: Props) {
  const drag = useRef<{ id: string; x: number; y: number; initialX: number; initialY: number }>();
  const start = (event: PointerEvent<HTMLButtonElement>, node: Node) => {
    onSelect(node.id);
    drag.current = { id: node.id, x: event.clientX, y: event.clientY, initialX: node.x, initialY: node.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current) return;
    onChange({ ...graph, nodes: graph.nodes.map((node) => node.id === current.id ? { ...node,
      x: Math.max(0, current.initialX + event.clientX - current.x),
      y: Math.max(0, current.initialY + event.clientY - current.y) } : node) });
  };
  const width = Math.max(1000, ...graph.nodes.map((node) => node.x + WIDTH + 100));
  const height = Math.max(650, ...graph.nodes.map((node) => node.y + HEIGHT + 100));
  return <div className="canvas-scroll"><div className="canvas" style={{ width, height }}>
    <svg width={width} height={height} aria-label="工作流连线">
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
        orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
      {graph.edges.map((edge, index) => {
        const from = graph.nodes.find((node) => node.id === edge.source);
        const to = graph.nodes.find((node) => node.id === edge.target);
        if (!from || !to) return null;
        const x = from.x + WIDTH; const y = from.y + HEIGHT / 2;
        const endY = to.y + HEIGHT / 2;
        return <g key={index}><path d={`M${x} ${y} C${x + 70} ${y},${to.x - 70} ${endY},${to.x} ${endY}`}
          fill="none" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />
          {edge.port !== undefined && <text x={x + 15} y={y - 10}>{edge.port ? "是" : "否"}</text>}</g>;
      })}
    </svg>
    {graph.nodes.map((node) => <button key={node.id} className={`canvas-node ${selected === node.id ? "active" : ""}`}
      style={{ left: node.x, top: node.y, width: WIDTH, height: HEIGHT }}
      onClick={() => onSelect(node.id)} onPointerDown={(event) => start(event, node)} onPointerMove={move}
      onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
      <small>{nodeLabels[node.type] ?? node.type}</small><strong>{node.name}</strong><span>{node.id}</span>
    </button>)}
  </div></div>;
}
