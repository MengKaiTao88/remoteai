import { useState } from "react";
import { Alert, Button, Input, Space, Tag } from "antd";
import type { Json } from "../types";
import type { Interaction, Run } from "./useWorkflowExecution";

const statusLabels: Record<string, string> = {
  completed: "已完成", paused: "等待回复", running: "运行中", failed: "失败",
  cancelled: "已停止", interrupted: "已中断",
};
function emptyValue(kind: string): Json {
  switch (kind) {
    case "string": return "";
    case "boolean": return false;
    case "object": return {};
    case "array": return [];
    default: return 0;
  }
}
interface Props { run: Run; busy: boolean; onResume: (runId: string, interactionId: string, input: Json) => void }

export function RunResult({ run, busy, onResume }: Props) {
  const interaction = run.interaction;
  return <div className="run-result"><h3>运行结果 <Tag>{statusLabels[run.status] ?? run.status}</Tag></h3>
    {run.error && <Alert type="error" message={run.error} />}
    {run.status === "paused" && interaction && <InteractionForm key={interaction.id}
      interaction={interaction} busy={busy} onSubmit={(input) => onResume(run.id, interaction.id, input)} />}
    {run.output !== null && run.output !== undefined && <pre>{typeof run.output === "string"
      ? run.output : JSON.stringify(run.output, null, 2)}</pre>}
    <h3>节点详情</h3>{run.trace.map((trace, index) => <pre key={index}>{JSON.stringify(trace, null, 2)}</pre>)}
  </div>;
}

function InteractionForm({ interaction, busy, onSubmit }: {
  interaction: Interaction; busy: boolean; onSubmit: (input: Json) => void;
}) {
  const defaults = Object.fromEntries(interaction.fields.map((field) => [field.name, emptyValue(field.kind)]));
  const [text, setText] = useState(JSON.stringify(defaults, null, 2));
  const [invalid, setInvalid] = useState(false);
  const singleText = interaction.fields.length === 1 && interaction.fields[0].kind === "string";
  const [answer, setAnswer] = useState("");
  const submit = () => {
    if (singleText) { onSubmit({ [interaction.fields[0].name]: answer }); return; }
    try { const input = JSON.parse(text) as Json; setInvalid(false); onSubmit(input); }
    catch { setInvalid(true); }
  };
  return <div><p>{interaction.prompt}</p>
    {interaction.choices.length ? <Space wrap>{interaction.choices.map((choice) =>
      <Button key={choice} disabled={busy} onClick={() => onSubmit({ answer: choice })}>{choice}</Button>)}</Space>
      : <>{singleText ? <Input.TextArea aria-label={interaction.fields[0].description || "回答"} value={answer}
        onChange={(event) => setAnswer(event.target.value)} rows={3} /> : <>
        <p>{interaction.fields.map((field) => `${field.description || field.name}${field.required ? "（必填）" : ""}`).join("、")}</p>
        <Input.TextArea aria-label="补充信息" rows={6} value={text} status={invalid ? "error" : undefined}
          onChange={(event) => setText(event.target.value)} />
        {invalid && <small className="error-text">请检查填写的内容。</small>}</>}
      <Button className="run-button" type="primary" loading={busy} onClick={submit}>继续运行</Button></>}
    <p><small>可以稍后在运行记录中继续，已完成的步骤会保留。</small></p>
  </div>;
}
