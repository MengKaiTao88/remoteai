import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface SharingPreferences {
  scope: 'off' | 'own' | 'everyone';
  uploadKibPerSecond: number;
  unmeteredOnly: boolean;
  prepareAndroid: boolean;
}
export interface SharingStatus {
  preferences: SharingPreferences;
  networkAllowed: boolean;
  peerBytes: number;
  originBytes: number;
  uploadedBytes: number;
  retries: number;
  failures: number;
}

export function useUpdateSharing(enabled: boolean) {
  const [status, setStatus] = useState<SharingStatus>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<'load' | 'save'>();
  const revision = useRef(0);
  const mounted = useRef(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    mounted.current = true;
    let canceled = false;
    let pending = false;
    const refresh = async () => {
      if (pending || savingRef.current || document.visibilityState === 'hidden') return;
      pending = true;
      const request = revision.current;
      try {
        const next = await invoke<SharingStatus>('update_sharing_status');
        if (!canceled && request === revision.current) {
          setStatus(next);
          setError(current => current === 'load' ? undefined : current);
        }
      } catch {
        if (!canceled && request === revision.current) setError('load');
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { canceled = true; mounted.current = false; window.clearInterval(timer); };
  }, [enabled]);

  const save = useCallback(async (settings: SharingPreferences) => {
    if (savingRef.current) return;
    savingRef.current = true; revision.current++;
    setSaving(true); setError(undefined);
    try {
      const next = await invoke<SharingStatus>('set_update_sharing_preferences', { settings });
      if (mounted.current) setStatus(next);
    } catch { if (mounted.current) setError('save'); }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  }, []);
  return { status, saving, error, save };
}
