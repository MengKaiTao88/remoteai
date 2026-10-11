import { useEffect, useState } from "react";
import { Alert, Button, Input, Select, Space, Typography } from "antd";
import { api, errorText } from "../api";
import type { Json, Resource } from "../types";
import { useWorkflowExecution, type Run } from "../workflow/useWorkflowExecution";
import { RunResult } from "../workflow/RunResult";

export function SharedWorkflow({ resourceId, published = true, save }: {
  resourceId: string; published?: boolean; save?: () => Promise<Resource>;
}) {
  const [input, setInput] = useState('{"text":"你好"}');
  const [history, setHistory] = useState<Run[]>([]);
  const execution = useWorkflowExecution();
  useEffect(() => {
    if (execution.busy) return;
    let active = true;
    void api<Run[]>("runs", { id: resourceId }).then((runs) => { if (active) setHistory(runs); })
      .catch((error: unknown) => { if (active) execution.setError(errorText(error)); });
    return () => { active = false; };
  }, [execution.busy, resourceId]);
  const run = async () => {
    execution.setError("");
    try {
      const value: unknown = JSON.parse(input);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请填写一组完整的输入内容。");
      if (save) await save();
      await execution.start("run_start", { resourceId, input: value, published });
    } catch (error) { execution.setError(errorText(error)); }
  };
  const resume = (runId: string, interactionId: string, input: Json) => {
    void execution.start("resume_run_start", { runId, interactionId, input });
  };
  return <section className="panel"><h2>{published ? "使用应用" : "工作流预览"}</h2>
    <Select placeholder="我的运行记录" allowClear disabled={execution.busy} style={{ minWidth: 260 }}
      value={execution.run?.id} options={history.map((run) => ({ value: run.id,
        label: `${run.createdAt ? new Date(run.createdAt).toLocaleString() : "运行记录"}${run.status === "paused" ? " · 等待回复" : ""}` }))}
      onChange={(id: string | undefined) => execution.setRun(history.find((run) => run.id === id))} />
    {execution.error && <Alert type="error" message={execution.error} closable onClose={() => execution.setError("")} />}
    <Typography.Paragraph>填写应用需要的输入内容，然后开始运行。</Typography.Paragraph>
    <Input.TextArea value={input} onChange={(event) => setInput(event.target.value)} rows={5} aria-label="应用输入" />
    <Space><Button type="primary" loading={execution.busy} onClick={() => void run()}>运行</Button>
      {execution.busy && <Button onClick={() => void execution.cancel()}>停止</Button>}</Space>
    {execution.text && <pre className="run-output">{execution.text}</pre>}
    {execution.run && <RunResult run={execution.run} busy={execution.busy} onResume={resume} />}
  </section>;
}
