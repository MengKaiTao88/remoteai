import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Dropdown, Input, List, Space, Upload } from "antd";
import { FileUp, History, Play, Plus, Square } from "lucide-react";
import { api, errorText } from "../api";
import type { Draft, Graph, Json, Model, Resource } from "../types";
import { Canvas } from "./Canvas";
import { NodeInspector } from "./NodeInspector";
import { newNode, nodeLabels } from "./nodes";
import { RunResult } from "./RunResult";
import { useWorkflowExecution, type Run } from "./useWorkflowExecution";

interface Props {
  resource: Resource; resources: Resource[]; draft: Draft; onChange: (draft: Draft) => void;
  save?: () => Promise<Resource>;
}

export function WorkflowEditor({ resource, resources, draft, onChange, save }: Props) {
  const graph = draft as unknown as Graph;
  const [selected, setSelected] = useState<string>();
  const [models, setModels] = useState<Model[]>([]);
  const [input, setInput] = useState('{"text":"你好"}');
  const [runs, setRuns] = useState<Run[]>([]);
  const [panel, setPanel] = useState<"run" | "history">();
  const execution = useWorkflowExecution();
  const { run, busy, error, setError } = execution;
  const [saving, setSaving] = useState(false);
  const [imported, setImported] = useState(false);
  const [modelError, setModelError] = useState("");
  useEffect(() => {
    void api<Model[]>("models").then(setModels).catch((error: unknown) => setModelError(errorText(error)));
  }, []);
  const change = (graph: Graph) => onChange(graph as unknown as Draft);
  const execute = async () => {
    setSaving(true); setError("");
    try {
      const value: unknown = JSON.parse(input);
      if (save) await save();
      await execution.start("run_start", { resourceId: resource.id, input: value, published: false });
    } catch (error) { setError(error instanceof SyntaxError ? "请填写有效的 JSON 输入。" : errorText(error)); }
    finally { setSaving(false); }
  };
  const resume = (runId: string, interactionId: string, input: Json) => {
    setPanel("run"); void execution.start("resume_run_start", { runId, interactionId, input });
  };
  const importCanvas = async (file: File) => {
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("文件过大，请选择较小的工作流。");
      const canvas: unknown = JSON.parse(await file.text());
      const graph = await api<Graph>("import_workflow", { canvas });
      change(graph); setSelected(undefined); setImported(true); setError("");
    } catch (error) { setError(error instanceof SyntaxError ? "文件内容无法读取，请检查后重试。" : errorText(error)); }
    return false;
  };
  const node = graph.nodes.find((node) => node.id === selected);
  return <div className="workflow-editor">
    <div className="workflow-toolbar"><Space>
      <Dropdown menu={{ items: Object.entries(nodeLabels).filter(([key]) => key !== "start")
        .map(([key, label]) => ({ key, label })), onClick: ({ key }) => {
          const node = newNode(key, graph.nodes.length); change({ ...graph, nodes: [...graph.nodes, node] });
          setSelected(node.id);
        } }}><Button icon={<Plus size={15} />}>添加节点</Button></Dropdown>
      <Upload accept=".json" showUploadList={false} beforeUpload={importCanvas}>
        <Button icon={<FileUp size={15} />}>导入画布</Button></Upload>
    </Space><Space>
      <Button icon={<History size={15} />} onClick={() => {
        setPanel("history"); void api<Run[]>("runs", { id: resource.id }).then(setRuns)
          .catch((error: unknown) => setError(errorText(error)));
      }}>运行记录</Button>
      <Button type="primary" icon={<Play size={15} />} onClick={() => setPanel("run")}>试运行</Button>
    </Space></div>
    {modelError && <Alert type="info" message={modelError} closable onClose={() => setModelError("")} />}
    {imported && <Alert type="info" message="画布已导入，请检查所用模型和输入内容后保存。"
      closable onClose={() => setImported(false)} />}
    {error && !panel && <Alert type="error" message={error} closable onClose={() => setError("")} />}
    <div className="workflow-workspace"><Canvas graph={graph} selected={selected} onSelect={setSelected} onChange={change} />
      {node && <NodeInspector key={node.id} node={node} graph={graph} resources={resources} models={models} onChange={change} />}
    </div>
    <Drawer title={panel === "run" ? "试运行" : "运行记录"} open={Boolean(panel)} onClose={() => setPanel(undefined)} width={540}>
      {error && <Alert type="error" message={error} />}
      {panel === "run" ? <><p>填写工作流的输入内容。</p><Input.TextArea aria-label="工作流输入" rows={5} value={input}
        onChange={(event) => setInput(event.target.value)} />
        <Space className="run-button"><Button type="primary" loading={busy || saving}
          onClick={() => void execute()}>开始运行</Button>
          {busy && <Button icon={<Square size={14} />} onClick={() => void execution.cancel()}>停止</Button>}</Space>
        {busy && <><pre aria-live="polite">{execution.text || "正在运行…"}</pre>
          {execution.trace.map((trace, index) => <pre key={index}>{JSON.stringify(trace, null, 2)}</pre>)}</>}
        {run && <RunResult run={run} busy={busy} onResume={resume} />}</> : <List dataSource={runs} renderItem={(item) =>
          <List.Item><details><summary>{item.createdAt}</summary>
            <RunResult run={item} busy={busy} onResume={resume} /></details></List.Item>} />}
    </Drawer>
  </div>;
}
