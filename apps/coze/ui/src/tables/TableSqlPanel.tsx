import { useEffect, useState } from "react";
import { Alert, Button, Input, Select, Space, Table } from "antd";
import { api, errorText } from "../api";
import type { Json, Model, Resource } from "../types";

interface QueryResult { columns: string[]; rows: Json[][]; truncated: boolean }

export function TableSqlPanel({ resource }: { resource: Resource }) {
  const [tables, setTables] = useState<Resource[]>([resource]);
  const [selected, setSelected] = useState<string[]>([resource.id]);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [question, setQuestion] = useState("");
  const [sql, setSql] = useState("SELECT * FROM t1 LIMIT 100");
  const [result, setResult] = useState<QueryResult>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<Resource[]>("list_resources").then((resources) => {
      if (active) setTables(resources.filter((item) => item.kind === "table"));
    }).catch((error: unknown) => { if (active) setError(errorText(error)); });
    void api<Model[]>("models").then((items) => { if (active) setModels(items); }).catch(() => {
      // SQL queries do not need a model; only natural-language generation does.
    });
    return () => { active = false; };
  }, []);
  const generate = async () => {
    setBusy("generate"); setError("");
    try {
      const result = await api<{ sql: string }>("generate_table_sql", { tables: selected, question, model });
      setSql(result.sql); setResult(undefined);
    } catch (error) { setError(errorText(error)); } finally { setBusy(""); }
  };
  const run = async () => {
    setBusy("query"); setError(""); setResult(undefined);
    try { setResult(await api<QueryResult>("table_sql", { tables: selected, sql })); }
    catch (error) { setError(errorText(error)); } finally { setBusy(""); }
  };
  const names = new Map(tables.map((table) => [table.id, table.name]));
  return <Space direction="vertical" style={{ width: "100%" }}>
    <p>选择要查询的数据表，可直接编写 SQL，也可让模型根据问题生成查询。</p>
    {error && <Alert type="error" message={error} />}
    <Select mode="multiple" aria-label="查询的数据表" value={selected} style={{ width: "100%" }}
      disabled={Boolean(busy)} onChange={setSelected} maxCount={8}
      options={tables.map((table) => ({ value: table.id, label: table.name }))} />
    <small>{selected.map((id, index) => `t${index + 1} = ${names.get(id) ?? id}`).join("；")}</small>
    <Select aria-label="查询生成模型" value={model || undefined} placeholder="选择用于理解问题的模型"
      style={{ width: "100%" }} onChange={setModel} disabled={Boolean(busy)} showSearch
      options={models.map((item) => ({ value: item.id, label: item.name }))} />
    <Input.TextArea aria-label="数据问题" value={question} rows={2} maxLength={2000}
      placeholder="例如：按城市统计本月销售额，从高到低排列" onChange={(event) => setQuestion(event.target.value)} />
    <Button loading={busy === "generate"} disabled={Boolean(busy) || !model || !question.trim() || !selected.length}
      onClick={() => void generate()}>生成查询</Button>
    <Input.TextArea aria-label="SQL 查询" value={sql} rows={5} onChange={(event) => setSql(event.target.value)} />
    <Button type="primary" loading={busy === "query"} disabled={Boolean(busy) || !sql.trim() || !selected.length}
      onClick={() => void run()}>运行查询</Button>
    <small>查询不会修改记录。生成后请先检查字段和筛选条件，再运行。</small>
    {result?.truncated && <Alert type="info" message="已显示前 1,000 条结果，请缩小查询范围以查看其余内容。" />}
    {result && <Table size="small" scroll={{ x: true }} pagination={{ pageSize: 20 }}
      rowKey="key" dataSource={result.rows.map((values, index) => ({ key: index, values }))}
      columns={result.columns.map((title, index) => ({ title, key: index,
        render: (_value: unknown, row: { values: Json[] }) => typeof row.values[index] === "object"
          ? JSON.stringify(row.values[index]) : String(row.values[index] ?? ""),
      }))} />}
  </Space>;
}
