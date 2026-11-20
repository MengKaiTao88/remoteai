  const localProxyProviderId = "codex-switch-local";
  const isActiveQuery = query => typeof query.isActive === "function"
    ? query.isActive() : (query.observers?.length ?? 0) > 0;
  const isEffectiveLocalConfig = query => {
    const key = query?.queryKey;
    return Array.isArray(key) && key[0] === "config" && key[1] === "effective" && key[2] === "local";
  };
  const hasActiveProxyModelQuery = (noAuthOnly = false) => queryClient.getQueryCache().getAll().some(query => {
    const key = query.queryKey;
    return isActiveQuery(query) && matchesModelsQuery(query) && key[2] === "local" &&
      (key[3] === "no-auth" || (!noAuthOnly && key.includes(localProxyProviderId)));
  });
  const usesEffectiveProxyConfig = () => queryClient.getQueryCache().getAll().some(query =>
    isEffectiveLocalConfig(query) && isActiveQuery(query)
    && query.state?.data?.config?.model_provider === localProxyProviderId);
  const syncComposerStatus = () => {
    // Updated Codex may read the ChatGPT catalog while requests follow the effective local provider.
    const allowed = proxyRunning && (hasActiveProxyModelQuery() || usesEffectiveProxyConfig());
    // Logged-in Codex already provides its own speed controls.
    const fastModeAllowed = allowed && fastModeModels.size > 0 && hasActiveProxyModelQuery(true);
    const changed = window.__CODEX_SWITCH_COMPOSER_STATUS_ALLOWED__ !== allowed ||
      window.__CODEX_SWITCH_FAST_MODE_ALLOWED__ !== fastModeAllowed;
    window.__CODEX_SWITCH_COMPOSER_STATUS_ALLOWED__ = allowed;
    window.__CODEX_SWITCH_FAST_MODE_ALLOWED__ = fastModeAllowed;
    if (changed) window.__CODEX_SWITCH_REFRESH_SPEED_SELECTOR__?.();
  };
  syncComposerStatus();
  window.__CODEX_SWITCH_COMPOSER_STATUS_OBSERVER__?.unsubscribe?.();
  window.__CODEX_SWITCH_COMPOSER_STATUS_OBSERVER__ = {
    proxyRunning,
    unsubscribe: queryClient.getQueryCache().subscribe(event => {
      if (matchesModelsQuery(event?.query) || isEffectiveLocalConfig(event?.query)) syncComposerStatus();
    }),
  };
  syncComposerStatus();
