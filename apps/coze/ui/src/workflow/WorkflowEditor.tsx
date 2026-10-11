import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Dropdown, Input, List, Space, Tag } from "antd";
import { History, Play, Plus } from "lucide-react";
import { api, errorText } from "../api";
import type { Draft, Graph, Json, Model, Resource } from "../types";
import { Canvas } from "./Canvas";
import { NodeInspector } from "./NodeInspector";
import { newNode, nodeLabels } from "./nodes";

interface Run { id: string; status: string; output: Json; error?: string; trace: Json[]; createdAt?: string }
interface Props {
  resource: Resource; resources: Resource[]; draft: Draft; onChange: (draft: Draft) => void;
  save?: () => Promise<Resource>;
}

export function WorkflowEditor({ resource, resources, draft, onChange, save }: Props) {
  const graph = draft as unknown as Graph;
  const [selected, setSelected] = useState<string>();
  const [models, setModels] = useState<Model[]>([]);
  const [input, setInput] = useState('{"text":"你好"}');
  const [run, setRun] = useState<Run>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [panel, setPanel] = useState<"run" | "history">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modelError, setModelError] = useState("");
  useEffect(() => {
    void api<Model[]>("models").then(setModels).catch((error: unknown) => setModelError(errorText(error)));
  }, []);
  const change = (graph: Graph) => onChange(graph as unknown as Draft);
  const execute = async () => {
    setBusy(true); setError("");
    try {
      const value: unknown = JSON.parse(input);
      if (save) await save();
      setRun(await api<Run>("run", { resourceId: resource.id, input: value, published: false }));
    } catch (error) { setError(error instanceof SyntaxError ? "请填写有效的 JSON 输入。" : errorText(error)); }
    finally { setBusy(false); }
  };
  const node = graph.nodes.find((node) => node.id === selected);
  return <div className="workflow-editor">
    <div className="workflow-toolbar"><Space>
      <Dropdown menu={{ items: Object.entries(nodeLabels).filter(([key]) => key !== "start")
        .map(([key, label]) => ({ key, label })), onClick: ({ key }) => {
          const node = newNode(key, graph.nodes.length); change({ ...graph, nodes: [...graph.nodes, node] });
          setSelected(node.id);
        } }}><Button icon={<Plus size={15} />}>添加节点</Button></Dropdown>
      <small>拖动节点调整位置，在右侧设置连线。</small>
    </Space><Space>
      <Button icon={<History size={15} />} onClick={() => {
        setPanel("history"); void api<Run[]>("runs", { id: resource.id }).then(setRuns)
          .catch((error: unknown) => setError(errorText(error)));
      }}>运行记录</Button>
      <Button type="primary" icon={<Play size={15} />} onClick={() => setPanel("run")}>试运行</Button>
    </Space></div>
    {modelError && <Alert type="info" message={modelError} closable onClose={() => setModelError("")} />}
    <div className="workflow-workspace"><Canvas graph={graph} selected={selected} onSelect={setSelected} onChange={change} />
      {node && <NodeInspector key={node.id} node={node} graph={graph} resources={resources} models={models} onChange={change} />}
    </div>
    <Drawer title={panel === "run" ? "试运行" : "运行记录"} open={Boolean(panel)} onClose={() => setPanel(undefined)} width={540}>
      {error && <Alert type="error" message={error} />}
      {panel === "run" ? <><p>填写工作流的输入内容。</p><Input.TextArea aria-label="工作流输入" rows={5} value={input}
        onChange={(event) => setInput(event.target.value)} />
        <Button className="run-button" type="primary" loading={busy} onClick={() => void execute()}>开始运行</Button>
        {run && <RunResult run={run} />}</> : <List dataSource={runs} renderItem={(item) =>
          <List.Item><details><summary>{item.createdAt} <Tag>{item.status === "completed" ? "成功" : "未完成"}</Tag></summary>
            <RunResult run={item} /></details></List.Item>} />}
    </Drawer>
  </div>;
}

function RunResult({ run }: { run: Run }) {
  return <div className="run-result"><h3>运行结果</h3>
    {run.error && <Alert type="error" message={run.error} />}
    <pre>{typeof run.output === "string" ? run.output : JSON.stringify(run.output, null, 2)}</pre>
    <h3>节点详情</h3>{run.trace.map((trace, index) => <pre key={index}>{JSON.stringify(trace, null, 2)}</pre>)}
  </div>;
}
