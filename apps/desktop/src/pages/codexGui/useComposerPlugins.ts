import { uiText } from "../../../../../shared/localization/uiText";
import { useEffect, useState } from "react";
import { guiApi } from "../../../../../shared/conversation/api";
import type { ComposerPlugin, PluginsResponse } from "../../../../../shared/conversation/attachmentTypes";

export function useComposerPlugins({ cwd, threadId, active }: { cwd: string; threadId?: string; active: boolean }) {
  const scope = JSON.stringify([cwd, threadId]);
  const [result, setResult] = useState({ scope, plugins: [] as ComposerPlugin[], loading: false, error: "" });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setResult({ scope, plugins: [], loading: true, error: "" });
    void guiApi.request<PluginsResponse>({ operation: "plugins", cwd: cwd || undefined,
      ...(threadId ? { threadId } : {}) }).then((response) => {
      if (cancelled) return;
      const plugins = [...new Map(response.marketplaces.flatMap((marketplace) => marketplace.plugins)
        .filter((plugin) => plugin.installed && plugin.enabled).map((plugin) => [plugin.id, plugin])).values()];
      setResult({ scope, plugins, loading: false,
        error: response.marketplaceLoadErrors.length ? uiText("client.workspaceActions.somePluginsCouldNotLoadReopenTheMenuToRetry") : "" });
    }).catch(() => {
      if (!cancelled) setResult({ scope, plugins: [], loading: false,
        error: uiText("client.workspaceActions.pluginsAreUnavailableReopenTheMenuToRetry") });
    });
    return () => { cancelled = true; };
  }, [scope, cwd, threadId, active]);
  return result.scope === scope ? result : { plugins: [], loading: active, error: "" };
}
