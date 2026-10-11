import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import type { Message, Resource } from "../types";

interface ToolTrace { id: string; name: string; input?: unknown; output?: unknown }
interface Event { sequence: number; event: { type: string; text?: string; conversationId?: string;
  step?: number; id?: string; name?: string; input?: unknown; output?: unknown } }
interface Job { status: string; events: Event[]; lastSequence: number;
  result?: { conversationId: string; message: Message }; error?: string }
interface Options { resourceId: string; save?: () => Promise<Resource>; published?: boolean }

export function useAgentChat({ resourceId, save, published = false }: Options) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<string>();
  const [conversations, setConversations] = useState<{ id: string; title: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [live, setLive] = useState("");
  const [step, setStep] = useState(0);
  const [traces, setTraces] = useState<ToolTrace[]>([]);
  const active = useRef<{ id?: string; stopped: boolean; timer?: ReturnType<typeof setTimeout> }>({ stopped: false });
  const refresh = () => api<{ id: string; title: string }[]>("conversations", { id: resourceId })
    .then((items) => { if (!active.current.stopped) setConversations(items); });
  useEffect(() => {
    active.current.stopped = false;
    void refresh().catch((error: unknown) => setError(errorText(error)));
    return () => {
      active.current.stopped = true;
      clearTimeout(active.current.timer);
      if (active.current.id) void api("job_cancel", { id: active.current.id }).catch(() => undefined);
    };
  }, [resourceId]);

  const selectConversation = async (id?: string) => {
    setError(""); setConversation(id); setLive(""); setTraces([]);
    try { setMessages(id ? await api<Message[]>("messages", { id }) : []); }
    catch (error) { setError(errorText(error)); }
  };
  const apply = ({ event }: Event) => {
    if (event.type === "conversation") setConversation(event.conversationId);
    if (event.type === "delta") setLive((text) => text + (event.text ?? ""));
    if (event.type === "step") { setStep(event.step ?? 1); setLive(""); }
    if (event.type === "tool_start") setTraces((items) => [...items,
      { id: event.id ?? "", name: event.name ?? "", input: event.input }]);
    if (event.type === "tool_end") setTraces((items) => {
      const item = items.find((item) => item.id === event.id);
      return item ? items.map((item) => item.id === event.id ? { ...item, output: event.output } : item)
        : [...items, { id: event.id ?? "", name: event.name ?? "", output: event.output }];
    });
  };
  const poll = async (id: string, after = 0): Promise<void> => {
    try {
      const job = await api<Job>("job_status", { id, after });
      if (active.current.stopped || active.current.id !== id) return;
      job.events.forEach(apply);
      const next = job.events.at(-1)?.sequence ?? after;
      if (job.status === "running" || next < job.lastSequence) {
        active.current.timer = setTimeout(() => { void poll(id, next); }, next < job.lastSequence ? 0 : 120);
        return;
      }
      if (job.result) {
        setConversation(job.result.conversationId);
        setMessages(await api<Message[]>("messages", { id: job.result.conversationId }));
        setLive("");
      } else { setError(job.status === "cancelled" ? "已停止生成。" : job.error ?? "回答未完成，请重试。"); }
      await refresh();
    } catch (error) { if (!active.current.stopped) setError(errorText(error)); }
    active.current.id = undefined;
    if (!active.current.stopped) setBusy(false);
  };
  const send = async (text: string) => {
    if (!text.trim() || busy) return false;
    setBusy(true); setError(""); setLive(""); setTraces([]); setStep(0);
    try {
      if (save) await save();
      const job = await api<{ id: string }>("chat_start", { agentId: resourceId,
        conversationId: conversation, message: text, published });
      active.current.id = job.id;
      if (active.current.stopped) { await api("job_cancel", { id: job.id }); return false; }
      setMessages((items) => [...items, { role: "user", content: text, citations: [] }]);
      void poll(job.id);
      return true;
    } catch (error) { setError(errorText(error)); setBusy(false); return false; }
  };
  const cancel = async () => {
    if (!active.current.id) return;
    try { await api("job_cancel", { id: active.current.id }); }
    catch (error) { setError(errorText(error)); }
  };
  return { messages, conversation, conversations, busy, error, live, step, traces,
    send, cancel, selectConversation, clearError: () => setError("") };
}
