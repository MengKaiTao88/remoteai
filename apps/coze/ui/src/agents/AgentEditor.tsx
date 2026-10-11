import { useEffect, useState } from "react";
import { Alert, Button, Empty, Input, Select, Slider, Space } from "antd";
import { Plus, Send } from "lucide-react";
import { api, errorText } from "../api";
import type { Draft, Message, Model, Resource } from "../types";

interface Props {
  resource: Resource; resources: Resource[]; draft: Draft; onChange: (draft: Draft) => void;
  save?: () => Promise<Resource>;
}

export function AgentEditor({ resource, resources, draft, onChange, save }: Props) {
  const [models, setModels] = useState<Model[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<string>();
  const [conversations, setConversations] = useState<{ id: string; title: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refreshModels = () => api<Model[]>("models").then(setModels).catch((error: unknown) => setError(errorText(error)));
  useEffect(() => { void refreshModels(); }, []);
  useEffect(() => {
    void api<{ id: string; title: string }[]>("conversations", { id: resource.id }).then(setConversations)
      .catch((error: unknown) => setError(errorText(error)));
  }, [resource.id, messages]);
  const update = (key: string, value: Draft[string]) => onChange({ ...draft, [key]: value });
  const send = async () => {
    if (!input.trim() || busy) return;
    setBusy(true); setError("");
    try {
      if (save) await save();
      const response = await api<{ conversationId: string; message: Message }>("chat", {
        agentId: resource.id, conversationId: conversation, message: input, published: false,
      });
      setConversation(response.conversationId);
      setMessages((previous) => [...previous, { role: "user", content: input, citations: [] }, response.message]);
      setInput("");
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  return <div className="two-columns agent-editor">
    <section className="panel"><h2>角色与能力</h2><label>模型</label>
      <Space.Compact block><Select className="grow" showSearch value={String(draft.model || "") || undefined}
        placeholder="选择 Remote AI 的模型" options={models.map((model) => ({ value: model.id, label: model.name }))}
        onChange={(value) => update("model", value)} />
        <Button onClick={() => void refreshModels()}>刷新</Button></Space.Compact>
      <label>角色提示词</label><Input.TextArea rows={12} value={String(draft.prompt ?? "")}
        onChange={(event) => update("prompt", event.target.value)} placeholder="描述它的角色、任务和回答方式…" />
      <Select className="full" placeholder="从提示词库插入" value={undefined}
        options={resources.filter((item) => item.kind === "prompt").map((item) => ({ value: item.id, label: item.name }))}
        onChange={(id) => update("prompt", `${String(draft.prompt ?? "")}\n${String(
          resources.find((item) => item.id === id)?.draft.text ?? "")}`)} />
      <label>知识库</label><Select mode="multiple" className="full" placeholder="选择可引用的知识库"
        value={(draft.knowledgeIds ?? []) as string[]} onChange={(value) => update("knowledgeIds", value)}
        options={resources.filter((item) => item.kind === "knowledge").map((item) => ({ value: item.id, label: item.name }))} />
      <label>回答创造性</label><Slider min={0} max={2} step={0.1} value={Number(draft.temperature ?? 0.7)}
        onChange={(value) => update("temperature", value)} />
    </section>
    <section className="panel chat-preview"><header><h2>对话预览</h2><Space>
      <Select placeholder="历史对话" allowClear value={conversation} disabled={busy} style={{ width: 180 }}
        options={conversations.map((item) => ({ value: item.id, label: item.title }))}
        onChange={(id: string | undefined) => {
          setConversation(id);
          if (!id) { setMessages([]); return; }
          void api<Message[]>("messages", { id }).then(setMessages).catch((error: unknown) => setError(errorText(error)));
        }} />
      <Button icon={<Plus size={14} />} disabled={busy} onClick={() => { setConversation(undefined); setMessages([]); }}>
        新对话</Button></Space></header>
      {error && <Alert type="error" message={error} closable onClose={() => setError("")} />}
      <div className="chat-messages">{!messages.length && <Empty description="发一条消息，试试它的表现" />}
        {messages.map((message, index) => <article key={index} className={`chat-message ${message.role}`}>
          <strong>{message.role === "user" ? "你" : resource.name}</strong><p>{message.content}</p>
          {message.citations.map((citation, index) => <details key={citation.chunkId}>
            <summary>[{index + 1}] {citation.documentName}</summary><p>{citation.text}</p></details>)}
        </article>)}</div>
      <Input.TextArea value={input} rows={3} placeholder="输入消息…" disabled={busy}
        onChange={(event) => setInput(event.target.value)} />
      <Button type="primary" icon={<Send size={15} />} loading={busy} disabled={!input.trim() || !draft.model}
        onClick={() => void send()}>发送</Button>
    </section>
  </div>;
}
