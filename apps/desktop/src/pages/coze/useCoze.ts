import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isDesktopApp } from "../../api/backend";

export interface CozeStatus {
  installed: boolean; version: string; phase: "idle" | "downloading" | "verifying" | "installing" | "starting";
  downloaded: number; total: number | null; url: string | null;
}

export function useCoze(active: boolean) {
  const [status, setStatus] = useState<CozeStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const polling = useRef(false);
  const action = useRef(false);
  const revision = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    if (polling.current || !isDesktopApp) return;
    polling.current = true;
    const startedAt = revision.current;
    try {
      const status = await invoke<CozeStatus>("coze_status");
      if (mounted.current && startedAt === revision.current) setStatus(status);
    } catch (error) { if (mounted.current) setError(String(error)); }
    finally { polling.current = false; }
  }, []);
  useEffect(() => {
    if (!active || !isDesktopApp) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);
  const run = async (command: "coze_install" | "coze_start" | "coze_stop") => {
    if (action.current) return;
    action.current = true; revision.current++; setBusy(true); setError("");
    try {
      const result = await invoke<CozeStatus>(command);
      if (mounted.current) setStatus({ ...result, phase: "idle" });
    } catch (error) { if (mounted.current) setError(String(error)); }
    finally { revision.current++; action.current = false; if (mounted.current) setBusy(false); }
  };
  return { status, busy: busy || (status !== undefined && status.phase !== "idle"), error,
    install: () => run("coze_install"), start: () => run("coze_start"), stop: () => run("coze_stop") };
}
