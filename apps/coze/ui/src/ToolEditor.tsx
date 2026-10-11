import { useState } from "react";
import { Alert, Button, Input, Select } from "antd";
import { api, errorText } from "./api";
import type { Draft, Json, Resource } from "./types";
import { useInvalidField } from "./draftValidation";

interface Props { resource: Resource; draft: Draft; onChange: (draft: Draft) => void; save?: () => Promise<Resource> }

export function ToolEditor({ resource, draft, onChange, save }: Props) {
  const [body, setBody] = useState(JSON.stringify(draft.body ?? {}, null, 2));
  const [input, setInput] = useState("{}");
  const [output, setOutput] = useState<Json>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useInvalidField(invalid);
  const test = async () => {
    setBusy(true); setError("");
    try { if (save) await save(); setOutput(await api<Json>("tool", { id: resource.id, input: JSON.parse(input) as Json })); }
    catch (error) { setError(error instanceof SyntaxError ? "请填写有效的 JSON。" : errorText(error)); }
    finally { setBusy(false); }
  };
  return <div className="two-columns"><section className="panel"><h2>HTTP 工具</h2>
    <p>连接公开的 HTTPS 服务，可在工作流中使用，也可发布给 Codex GUI。</p>
    <label>请求地址<Input value={String(draft.url ?? "")} placeholder="https://example.com/api"
      onChange={(event) => onChange({ ...draft, url: event.target.value })} /></label>
    <small>可用 {"{{input.字段名}}"} 引用调用参数。</small>
    <label>请求方式<Select className="full" value={String(draft.method ?? "GET")}
      options={["GET", "POST", "PUT", "DELETE"].map((value) => ({ value }))}
      onChange={(value) => onChange({ ...draft, method: value })} /></label>
    <label>请求内容<Input.TextArea rows={10} value={body} onChange={(event) => {
      setBody(event.target.value);
      try { onChange({ ...draft, body: JSON.parse(event.target.value) as Json }); setError(""); setInvalid(false); }
      catch { setError("请求内容需要是有效的 JSON。"); setInvalid(true); }
    }} /></label>
  </section><section className="panel"><h2>工具测试</h2>
    {error && <Alert type="error" message={error} />}
    <label>调用参数<Input.TextArea rows={8} value={input} onChange={(event) => setInput(event.target.value)} /></label>
    <Button type="primary" loading={busy} onClick={() => void test()}>运行测试</Button>
    {output !== undefined && <pre>{JSON.stringify(output, null, 2)}</pre>}
  </section></div>;
}
