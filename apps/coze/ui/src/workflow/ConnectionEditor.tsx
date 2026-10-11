import { useState } from "react";
import { App, Button, Select } from "antd";
import type { Graph, Node } from "../types";
import { connectionError, edgeId } from "./graphEditing";

export function ConnectionEditor({ node, graph, onChange }: {
  node: Node; graph: Graph; onChange: (graph: Graph) => void;
}) {
  const [target, setTarget] = useState<string>();
  const [port, setPort] = useState(true);
  const { message } = App.useApp();
  return <details className="connection-controls"><summary>连接到下一步</summary>
    <small>也可以拖拽画布上的圆点连接节点。</small>
    {node.type === "condition" && <Select className="full" value={String(port)}
      options={[{ value: "true", label: "条件成立" }, { value: "false", label: "条件不成立" }]}
      onChange={(value) => setPort(value === "true")} />}
    <Select className="full" placeholder="选择要连接的节点" value={target} onChange={setTarget}
      options={graph.nodes.filter((item) => item.id !== node.id && item.type !== "start")
        .map((item) => ({ value: item.id, label: item.name }))} />
    <Button disabled={!target} onClick={() => {
      if (!target) return;
      const edge = { source: node.id, target, ...(node.type === "condition" ? { port } : {}) };
      const error = connectionError(graph, edge);
      if (error) { void message.info(error); return; }
      onChange({ ...graph, edges: [...graph.edges, edge] }); setTarget(undefined);
    }}>连接</Button>
    {graph.edges.filter((edge) => edge.source === node.id).map((edge) => <Button key={edgeId(edge)}
      type="text" danger onClick={() => onChange({ ...graph, edges: graph.edges.filter((item) => item !== edge) })}>
      移除{edge.port == null ? "" : edge.port ? "成立分支" : "不成立分支"}
      → {graph.nodes.find((node) => node.id === edge.target)?.name}</Button>)}
  </details>;
}
