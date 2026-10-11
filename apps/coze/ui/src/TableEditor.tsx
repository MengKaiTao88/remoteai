import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Input, List, Popconfirm } from "antd";
import { api, errorText } from "./api";
import type { Json, Resource } from "./types";

export function TableEditor({ resource }: { resource: Resource }) {
  const [rows, setRows] = useState<{ id: string; value: Json }[]>([]);
  const [text, setText] = useState('{"名称": "", "内容": ""}');
  const [editing, setEditing] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => api<typeof rows>("table_rows", { id: resource.id }).then(setRows), [resource.id]);
  useEffect(() => { void refresh().catch((error: unknown) => setError(errorText(error))); }, [refresh]);
  const save = async () => {
    setBusy(true); setError("");
    try {
      await api("save_table_row", { table_id: resource.id, id: editing, value: JSON.parse(text) as Json });
      setEditing(undefined); await refresh();
    } catch (error) { setError(error instanceof SyntaxError ? "请填写有效的 JSON 对象。" : errorText(error)); }
    finally { setBusy(false); }
  };
  return <section className="panel"><h2>数据记录</h2>
    {error && <Alert type="error" message={error} />}
    <Input.TextArea aria-label="记录内容" rows={4} value={text} onChange={(event) => setText(event.target.value)} />
    <Button onClick={() => void save()} loading={busy}>{editing ? "保存记录" : "新增记录"}</Button>
    <List dataSource={rows} renderItem={(row) => <List.Item actions={[
      <Button key="edit" onClick={() => { setEditing(row.id); setText(JSON.stringify(row.value, null, 2)); }}>编辑</Button>,
      <Popconfirm key="delete" title="确定删除这条记录？" overlayStyle={{ maxWidth: 400 }} onConfirm={async () => {
        try { await api("delete_table_row", { table_id: resource.id, id: row.id }); await refresh(); }
        catch (error) { setError(errorText(error)); }
      }}><Button danger>删除</Button></Popconfirm>,
    ]}><pre>{JSON.stringify(row.value, null, 2)}</pre></List.Item>} />
  </section>;
}
