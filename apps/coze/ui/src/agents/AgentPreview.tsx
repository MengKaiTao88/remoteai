import { useState } from "react";
import { Alert, Button, Empty, Input, Select, Space, Tag } from "antd";
import { Plus, Send, Square } from "lucide-react";
import type { Draft, Resource } from "../types";
import { useAgentChat } from "./useAgentChat";

interface Props { resource: Resource; draft: Draft; save?: () => Promise<Resource>; published?: boolean }

export function AgentPreview({ resource, draft, save, published }: Props) {
  const chat = useAgentChat({ resourceId: resource.id, save, published });
  const [input, setInput] = useState("");
  const send = async () => { if (await chat.send(input)) setInput(""); };
  return <section className="panel chat-preview"><header><h2>对话预览</h2><Space wrap>
    <Select placeholder="历史对话" allowClear value={chat.conversation} disabled={chat.busy} style={{ width: 180 }}
      options={chat.conversations.map((item) => ({ value: item.id, label: item.title }))}
      onChange={(id: string | undefined) => void chat.selectConversation(id)} />
    <Button icon={<Plus size={14} />} disabled={chat.busy} onClick={() => void chat.selectConversation()}>
      新对话</Button></Space></header>
    {chat.error && <Alert type="info" message={chat.error} closable onClose={chat.clearError} />}
    <div className="chat-messages">
      {!chat.messages.length && !chat.busy && <Empty description="发一条消息，试试它的表现" />}
      {chat.messages.map((message, index) => message.role === "tool"
        ? <details key={index}><summary>工具返回结果</summary><pre style={{ whiteSpace: "pre-wrap" }}>
          {message.content}</pre></details>
        : <article key={index} className={`chat-message ${message.role}`}>
          <strong>{message.role === "user" ? "你" : resource.name}</strong><p>{message.content}</p>
          {message.citations.map((citation, index) => <details key={citation.chunkId}>
            <summary>[{index + 1}] {citation.documentName}</summary><p>{citation.text}</p></details>)}
        </article>)}
      {chat.traces.length > 0 && <details open={chat.busy}><summary>本轮工具调用（{chat.traces.length}）</summary>
        {chat.traces.map((trace) => <details key={trace.id}><summary>
          {trace.output === undefined ? "调用中" : "已返回"} · {trace.name}</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify({ input: trace.input, output: trace.output }, null, 2)}</pre>
        </details>)}
      </details>}
      {(chat.live || chat.busy) && <article className="chat-message assistant" aria-live="polite">
        <strong>{resource.name}</strong>{chat.busy && <Tag>正在回答{chat.step > 1 ? ` · 第 ${chat.step} 轮` : ""}</Tag>}
        <p>{chat.live || "正在准备…"}</p></article>}
    </div>
    <Input.TextArea value={input} rows={3} placeholder="输入消息…" disabled={chat.busy}
      onChange={(event) => setInput(event.target.value)} />
    <Space><Button type="primary" icon={<Send size={15} />} loading={chat.busy} disabled={!input.trim() || !draft.model}
      onClick={() => void send()}>发送</Button>
      {chat.busy && <Button icon={<Square size={14} />} onClick={() => void chat.cancel()}>停止</Button>}
    </Space>
  </section>;
}
