import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import type { InputField, Json } from "../types";

export interface Interaction { id: string; nodeId: string; prompt: string; fields: InputField[]; choices: string[] }
export interface Run {
  id: string; status: string; output: Json; error?: string; trace: Json[];
  createdAt?: string; interaction?: Interaction;
}
interface Job {
  status: string; result?: Run; error?: string; lastSequence: number;
  events: { sequence: number; event: { type: string; text?: string; trace?: Json } }[];
}

export function useWorkflowExecution() {
  const [jobId, setJobId] = useState<string>();
  const [run, setRun] = useState<Run>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [trace, setTrace] = useState<Json[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
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
          if (event.type === "delta" && event.text) setText((text) => text + event.text);
          if (event.type === "node" && event.trace !== undefined) {
            const item = event.trace; setTrace((trace) => [...trace, item]);
          }
        }
        if (job.status === "running" || after < job.lastSequence) {
          timer = setTimeout(() => void poll(), 200); return;
        }
        if (job.result) setRun(job.result);
        if (job.error) setError(job.error);
        if (job.status === "cancelled" && !job.result) setError("运行已停止。");
        setBusy(false); setJobId(undefined);
      } catch (error) {
        if (!active) return;
        setError(errorText(error)); setBusy(false); setJobId(undefined);
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [jobId]);
  const start = async (method: "run_start" | "resume_run_start", params: unknown) => {
    setBusy(true); setError(""); setText(""); setTrace([]);
    try {
      const job = await api<{ id: string }>(method, params);
      if (mounted.current) { setRun(undefined); setJobId(job.id); }
    } catch (error) {
      if (mounted.current) { setError(errorText(error)); setBusy(false); }
    }
  };
  const cancel = async () => {
    if (!jobId) return;
    try { await api("job_cancel", { id: jobId }); }
    catch (error) { if (mounted.current) setError(errorText(error)); }
  };
  return { run, setRun, busy, error, setError, text, trace, start, cancel };
}
