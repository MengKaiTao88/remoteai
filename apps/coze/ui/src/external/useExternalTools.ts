import { useEffect, useState } from "react";
import { api, errorText } from "../api";

export interface ToolSettings { enabled: boolean; mode: "local" | "network"; port: number }
export interface ToolStatus { settings: ToolSettings; urls: string[] }
interface Grant { id: string; name: string; role: string; expiresAt: string; revokedAt: string | null }
interface Issued { id: string; token: string }

export function useExternalTools(resourceId: string) {
  const [status, setStatus] = useState<ToolStatus | null>(null);
  const [items, setItems] = useState<Grant[]>([]);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    const values = await api<Grant[]>("list_access", { id: resourceId });
    setItems(values.filter((item) => item.role === "tool"));
  };
  useEffect(() => {
    let current = true;
    setStatus(null); setIssued(null); setItems([]); setError("");
    void Promise.all([api<ToolStatus>("tool_service_status"),
      api<Grant[]>("list_access", { id: resourceId })]).then(([next, keys]) => {
      if (current) { setStatus(next); setItems(keys.filter((key) => key.role === "tool")); }
    }).catch((error: unknown) => { if (current) setError(errorText(error)); });
    return () => { current = false; };
  }, [resourceId]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  return { status, items, issued, busy, error, setError, clearIssued: () => setIssued(null),
    configure: (settings: ToolSettings) => perform(async () => {
      setStatus(await api<ToolStatus>("configure_tool_service", settings));
    }),
    issue: (name: string, expiresDays: number) => perform(async () => {
      setIssued(await api<Issued>("issue_access", { appId: resourceId, name, role: "tool", expiresDays }));
      await refresh();
    }),
    revoke: (id: string) => perform(async () => {
      await api("revoke_access", { id });
      if (issued?.id === id) setIssued(null);
      await refresh();
    }),
  };
}
