import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { pullCloudTotp, syncCloudTotp } from '../api/backend';
import { totpVaultsEqual, type TotpVault } from '../utils/totp';

const SYNC_INTERVAL_MS = 30_000;

interface Options {
  authenticated: boolean;
  identity: string;
  enabled: boolean;
  vaultRef: MutableRefObject<TotpVault>;
  applyRemoteVault: (vault: TotpVault) => void;
  onError: (error: unknown) => void;
}

/** Serialize reads and writes; polling also retries local changes after an offline failure. */
export function useTotpCloudSync(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const scope = `${options.authenticated}|${options.identity}`;
  const generation = useRef({ scope });
  if (generation.current.scope !== scope) generation.current = { scope };
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    generation.current = { scope };
    return () => { generation.current = { scope: '' }; };
  }, [scope]);

  const syncCloud = useCallback((background = false) => {
    if (!latest.current.authenticated || (background && pending.current > 0)) return Promise.resolve();
    const expected = generation.current;
    const current = () => generation.current === expected && latest.current.authenticated;
    pending.current += 1;
    setSyncing(true);
    const operation = queue.current.catch(() => undefined).then(async () => {
      if (!current()) return;
      const remote = await pullCloudTotp();
      if (!current()) return;
      if (remote) latest.current.applyRemoteVault(remote);
      if (!latest.current.enabled) return;
      const local = latest.current.vaultRef.current;
      if (remote && totpVaultsEqual(local, remote)) return;
      const response = await syncCloudTotp(local);
      if (current()) latest.current.applyRemoteVault(response);
    }).catch(error => {
      if (current() && !background) latest.current.onError(error);
    }).finally(() => {
      pending.current -= 1;
      if (pending.current === 0) setSyncing(false);
    });
    queue.current = operation;
    return operation;
  }, []);

  useEffect(() => {
    if (!options.authenticated) return;
    void syncCloud();
  }, [options.authenticated, options.identity, options.enabled, syncCloud]);

  useEffect(() => {
    if (!options.authenticated || !options.enabled) return;
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void syncCloud(true);
    };
    const timer = window.setInterval(refresh, SYNC_INTERVAL_MS);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [options.authenticated, options.enabled, syncCloud]);

  return { syncing, syncCloud };
}
