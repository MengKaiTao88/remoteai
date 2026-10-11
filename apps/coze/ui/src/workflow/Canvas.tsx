import { useEffect, useRef, type KeyboardEvent } from "react";
import { App, Button, Space } from "antd";
import { Copy, Trash2 } from "lucide-react";
import { Background, Panel, ReactFlow, ReactFlowProvider, SelectionMode, useEdgesState, useNodesState,
  useReactFlow, type Connection, type NodePositionChange } from "@xyflow/react";
import type { Graph } from "../types";
import { connectionError, edgeId, MAX_NODES, removeSelection } from "./graphEditing";
import { fromConnection, toEdges, toNodes } from "./flowAdapter";
import { WorkflowNode, type CanvasNode } from "./WorkflowNode";
import { CanvasControls, type HistoryControls } from "./CanvasControls";
import { NodePalette } from "./NodePalette";
import { newNode } from "./nodes";
import { useCanvasResize } from "./useCanvasResize";
import "@xyflow/react/dist/style.css";
import "./canvas.css";

interface Props {
  graph: Graph; selected?: string; onSelect: (id?: string) => void;
  onChange: (graph: Graph) => void; history: HistoryControls;
}
const nodeTypes = { workflow: WorkflowNode };

export function Canvas(props: Props) {
  return <ReactFlowProvider><WorkflowCanvas {...props} /></ReactFlowProvider>;
}

function WorkflowCanvas({ graph, selected, onSelect, onChange, history }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(toNodes(graph, selected));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toEdges(graph));
  const container = useRef<HTMLDivElement>(null);
  const reconnecting = useRef<string>();
  const flow = useReactFlow<CanvasNode>();
  useCanvasResize(container);
  const { message } = App.useApp();
  useEffect(() => setNodes(toNodes(graph, selected)), [graph, selected, setNodes]);
  useEffect(() => setEdges(toEdges(graph)), [graph, setEdges]);
  const connect = (connection: Connection, replaced?: string) => {
    const edge = fromConnection(connection);
    const base = { ...graph, edges: graph.edges.filter((item) => edgeId(item) !== replaced) };
    const error = connectionError(base, edge);
    if (error) { void message.info(error); return; }
    onChange({ ...base, edges: [...base.edges, edge] });
  };
  const add = (type: string) => {
    if (graph.nodes.length >= MAX_NODES) { void message.info("节点数量已达到上限。"); return; }
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return;
    const position = flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    const node = { ...newNode(type, graph.nodes.length), x: position.x - 120, y: position.y - 50 };
    onChange({ ...graph, nodes: [...graph.nodes, node] }); onSelect(node.id);
  };
  const remove = () => {
    onChange(removeSelection(graph, nodes.filter((node) => node.selected).map((node) => node.id),
      edges.filter((edge) => edge.selected).map((edge) => edge.id)));
    onSelect(undefined);
  };
  const duplicate = () => {
    const node = graph.nodes.find((node) => node.id === selected);
    if (!node || node.type === "start" || graph.nodes.length >= MAX_NODES) return;
    const copy = { ...node, id: newNode(node.type, 0).id, name: `${node.name} 副本`, x: node.x + 40, y: node.y + 140 };
    onChange({ ...graph, nodes: [...graph.nodes, copy] }); onSelect(copy.id);
  };
  const shortcut = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLElement && event.target.closest("input,textarea,[contenteditable=true]")) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (modifier && key === "z") { event.preventDefault(); event.shiftKey ? history.redo() : history.undo(); }
    if (modifier && key === "y") { event.preventDefault(); history.redo(); }
    if (modifier && key === "d") { event.preventDefault(); duplicate(); }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); remove(); }
    if (event.key === "Escape") onSelect(undefined);
  };
  const hasSelection = nodes.some((node) => node.selected) || edges.some((edge) => edge.selected);
  return <div ref={container} className="workflow-canvas" aria-label="工作流画布" tabIndex={0}
    onKeyDown={shortcut} onPointerDownCapture={() => container.current?.focus({ preventScroll: true })}>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={(changes) => {
      onNodesChange(changes);
      const completed = changes.filter((item): item is NodePositionChange =>
        item.type === "position" && item.dragging === false);
      if (!completed.length) return;
      const positions = new Map(completed.map((item) => [item.id, item.position]));
      onChange({ ...graph, nodes: graph.nodes.map((node) => ({ ...node, ...positions.get(node.id) })) });
    }}
      onEdgesChange={onEdgesChange} fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      minZoom={0.2} maxZoom={2} deleteKeyCode={null} selectionMode={SelectionMode.Partial}
      multiSelectionKeyCode={["Control", "Meta", "Shift"]}
      onNodeClick={(event, node) => {
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey) onSelect(node.id);
      }} onPaneClick={() => onSelect(undefined)}
      onConnect={(connection) => connect(connection)}
      onReconnectStart={(_, edge) => { reconnecting.current = edge.id; }}
      onReconnect={((edge, connection) => connect(connection, edge.id))}
      onReconnectEnd={() => { reconnecting.current = undefined; }}
      isValidConnection={(connection) => !connectionError({ ...graph,
        edges: graph.edges.filter((edge) => edgeId(edge) !== reconnecting.current) }, fromConnection(connection))}>
      <Background color="var(--border)" gap={20} size={1.5} />
      <Panel position="top-left"><Space><NodePalette onAdd={add} />{hasSelection && <>
        <Button aria-label="复制节点" icon={<Copy size={15} />} onClick={duplicate}
          disabled={!selected || graph.nodes.find((node) => node.id === selected)?.type === "start"} />
        <Button aria-label="删除所选" icon={<Trash2 size={15} />} onClick={remove} />
      </>}</Space></Panel>
      <CanvasControls graph={graph} onChange={onChange} history={history} />
      <Panel position="bottom-right" className="canvas-hint">拖拽圆点连线 · 滚轮缩放 · Shift 框选</Panel>
    </ReactFlow>
  </div>;
}
