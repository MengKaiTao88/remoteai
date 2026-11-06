import { useEffect } from 'react';
import { ChatHost } from './host';
import { retainGuiSession } from '../pages/codexGui/session';
import { mobileConnection } from './mobileConnection';
import { invoke } from '@tauri-apps/api/core';

const HOST_HEARTBEAT_MS = 10_000;
// Stable across host/transport restarts, different after an actual page reload.
const RENDERER_ID = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
interface HostHealthStatus { restartRequired: boolean }

export function useChatHost() {
  useEffect(() => {
    const releaseSession = retainGuiSession();
    let host = new ChatHost(mobileConnection.setConnected);
    let pending = false;
    let active = true;
    const heartbeat = async () => {
      if (pending || !active) return;
      pending = true;
      try {
        const status = await invoke<HostHealthStatus>('remote_chat_host_alive', {
          active: mobileConnection.getSnapshot(),
          rendererId: RENDERER_ID,
        });
        if (active && status.restartRequired) {
          host.close();
          host = new ChatHost(mobileConnection.setConnected);
        }
      }
      catch { console.warn('Chat host health check unavailable.'); }
      finally { pending = false; }
    };
    const timer = setInterval(() => { void heartbeat(); }, HOST_HEARTBEAT_MS);
    const unload = () => host.close();
    window.addEventListener('beforeunload', unload);
    void heartbeat();
    return () => {
      active = false; clearInterval(timer); host.close(); releaseSession();
      window.removeEventListener('beforeunload', unload);
      void invoke('remote_chat_host_alive', { active: false, rendererId: RENDERER_ID }).catch(() => {
        // During process shutdown the host no longer exists, so the lease cannot be explicitly cleared.
      });
    };
  }, []);
}

export function RemoteChatHost() { useChatHost(); return null; }
