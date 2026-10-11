import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";

interface Progress { type?: string; stage?: string; completed?: number; total?: number }
interface Job {
  status: "running" | "completed" | "failed" | "cancelled";
  events: { sequence: number; event: Progress }[]; error?: string;
}

const labels: Record<string, string> = {
  parse: "正在读取文档", download: "正在读取网页", recognize: "正在识别内容", index: "正在整理知识",
};

export function useKnowledgeJob(options: {
  scope: string; onComplete: () => Promise<void>; onError: (error: string) => void;
}) {
  const { scope, onComplete, onError } = options;
  const storageKey = `coze-import-${scope}`;
  const [jobId, setJobId] = useState(() => sessionStorage.getItem(storageKey) ?? "");
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState("");
  const pending = useRef(false);
  const start = useCallback(async (method: string, params: unknown) => {
    if (pending.current || jobId) return;
    pending.current = true; setStarting(true); setProgress("正在准备导入"); onError("");
    try {
      const result = await api<{ id: string }>(method, params);
      sessionStorage.setItem(storageKey, result.id); setJobId(result.id);
    } catch (error) { onError(errorText(error)); setProgress(""); }
    finally { pending.current = false; setStarting(false); }
  }, [jobId, onError, storageKey]);
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let after = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const job = await api<Job>("job_status", { id: jobId, after });
        if (!active) return;
        for (const { sequence, event } of job.events) {
          after = sequence;
          if (event.type !== "progress") continue;
          const count = event.total ? `（${event.completed ?? 0} / ${event.total}）` : "";
          setProgress(`${labels[event.stage ?? ""] ?? "正在处理"}${count}`);
        }
        if (job.status === "running") { timer = setTimeout(() => void poll(), 500); return; }
        sessionStorage.removeItem(storageKey); setJobId("");
        setProgress(job.status === "completed" ? "导入完成" : job.status === "cancelled" ? "已取消导入" : "");
        if (job.status === "failed") onError(job.error || "导入未完成，请重试。");
        if (job.status === "completed") await onComplete();
      } catch (error) {
        if (!active) return;
        const message = errorText(error);
        if (message.includes("未找到这项内容")) {
          sessionStorage.removeItem(storageKey); setJobId(""); setProgress("");
          onError("上次导入已结束或连接已重启，请检查文档列表。"); return;
        }
        onError(message);
        timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [jobId, onComplete, onError, storageKey]);
  const cancel = async () => {
    if (!jobId) return;
    try { await api("job_cancel", { id: jobId }); setProgress("正在取消导入"); }
    catch (error) { onError(errorText(error)); }
  };
  return { busy: starting || Boolean(jobId), progress, start, cancel, cancellable: Boolean(jobId) };
}
