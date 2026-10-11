import { useState } from "react";
import { Button, Empty, Input, Popover } from "antd";
import { Plus, Search } from "lucide-react";
import { nodeLabels } from "./nodes";

const groups = [
  { label: "AI 与知识", types: ["llm", "knowledge", "intent", "knowledge_write", "knowledge_delete"] },
  { label: "逻辑与交互", types: ["condition", "subworkflow", "loop", "repeat", "break", "continue",
    "input", "output", "end"] },
  { label: "文本与变量", types: ["template", "code", "variable", "aggregate", "aggregate_groups",
    "json_parse", "json_stringify"] },
  { label: "工具与数据", types: ["plugin", "http", "conversation", "sql", "nl2sql", "table_query",
    "table_write", "table_update", "table_delete"] },
];

export function NodePalette({ onAdd }: { onAdd: (type: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const filtered = groups.map((group) => ({ ...group, types: group.types.filter((type) =>
    `${nodeLabels[type]} ${type}`.toLowerCase().includes(search.toLowerCase())) }));
  return <Popover trigger="click" placement="bottomLeft" open={open}
    onOpenChange={(value) => { setOpen(value); if (!value) setSearch(""); }}
    content={<div className="node-palette"><Input aria-label="搜索节点" placeholder="搜索节点"
      prefix={<Search size={14} />} value={search} onChange={(event) => setSearch(event.target.value)} allowClear />
      <div className="node-palette-list">{filtered.map((group) => group.types.length > 0 && <section key={group.label}>
        <h4>{group.label}</h4><div>{group.types.map((type) => <Button key={type} type="text"
          onClick={() => { onAdd(type); setOpen(false); setSearch(""); }}>{nodeLabels[type]}</Button>)}</div>
      </section>)}{filtered.every((group) => !group.types.length) && <Empty description="没有找到节点" />}</div>
    </div>}><Button icon={<Plus size={15} />}>添加节点</Button></Popover>;
}
