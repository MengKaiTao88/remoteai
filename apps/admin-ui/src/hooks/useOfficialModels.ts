import { useEffect, useRef, useState } from "react";
import { App } from "antd";

export interface OfficialModelsSnapshot {
  catalog: Record<string, unknown> | null;
  revision: string;
  updatedAt: string;
  source: string;
}
export interface OfficialModelsProps {
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  canManage: boolean;
}
const ENDPOINT = "/admin/api/official-models";
const noticeStyle = { maxWidth: 400, whiteSpace: "normal" as const };

export function useOfficialModels(api: OfficialModelsProps["api"], zh: boolean) {
  const { message } = App.useApp();
  const [snapshot, setSnapshot] = useState<OfficialModelsSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"save" | "refresh" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const active = useRef(true);
  const pending = useRef(false);
  const accept = (value: OfficialModelsSnapshot) => {
    setSnapshot(value);
    setDraft(JSON.stringify(value.catalog ?? { models: [] }, null, 2));
  };

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    void api<OfficialModelsSnapshot>(ENDPOINT).then((value) => { if (current) accept(value); })
      .catch(() => {
        if (current) message.error({ content: zh ? "模型列表加载失败，请重试。"
          : "Unable to load models. Please retry.", style: noticeStyle });
      }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, attempt, message, zh]);

  const submit = async (operation: "save" | "refresh") => {
    if (pending.current || !snapshot) return;
    let body: string | undefined;
    if (operation === "save") {
      try { body = JSON.stringify({ catalog: JSON.parse(draft) as unknown, revision: snapshot.revision }); }
      catch {
        message.error({ content: zh ? "内容格式有误，请检查后重试。"
          : "Check the content format and try again.", style: noticeStyle });
        return;
      }
    }
    pending.current = true;
    setAction(operation);
    try {
      const value = await api<OfficialModelsSnapshot>(operation === "save" ? ENDPOINT : `${ENDPOINT}/refresh`,
        { method: operation === "save" ? "PATCH" : "POST", body });
      if (!active.current) return;
      accept(value);
      message.success({ content: zh ? "模型列表已更新。" : "Model list updated.", style: noticeStyle });
    } catch (error) {
      if (active.current) message.error({ content: error instanceof Error ? error.message
        : (zh ? "更新失败，请重试。" : "Unable to update. Please retry."), style: noticeStyle });
    } finally {
      pending.current = false;
      if (active.current) setAction(null);
    }
  };
  return { snapshot, draft, setDraft, loading, action, submit, reload: () => setAttempt((value) => value + 1) };
}
