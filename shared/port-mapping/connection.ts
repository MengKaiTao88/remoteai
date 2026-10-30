import type { ChatConnection, ConnectionEvents } from '../remote-chat/client/connection';
import { createGuiFilesClient } from '../remote-chat/files';
import type { MappingConnection } from './deviceRuntime';
import { chatHandshake } from '../remote-chat/handshake';

const RETRY_DELAY_MS = 5_000;

/** Mapping sessions perform capability negotiation without loading chat history or selecting a thread. */
export function createMappingConnection(create: (events: ConnectionEvents) => ChatConnection): MappingConnection {
  let state = { ready: false, error: '' };
  let active = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let negotiating: number | undefined;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener());
  };
  const negotiate = async () => {
    if (!active || state.ready || negotiating === generation) return;
    const version = generation;
    negotiating = version;
    try {
      const capabilities = await connection.request<unknown>('connect', chatHandshake);
      if (!active || version !== generation) return;
      connection.setBulkSupport(capabilities);
      update({ ready: true, error: '' });
    } catch {
      if (!active || version !== generation) return;
      update({ ready: false, error: 'client.mappingHub.retrying' });
      timer = setTimeout(() => { void negotiate(); }, RETRY_DELAY_MS);
    } finally { if (negotiating === version) negotiating = undefined; }
  };
  const connection = create({ ready: () => { clearTimeout(timer); void negotiate(); }, event: () => {},
    mode: mode => {
      if (mode === 'direct' || mode === 'relay') { void negotiate(); return; }
      generation += 1; clearTimeout(timer); update({ ready: false });
    }, error: error => update({ error }) });
  return {
    files: createGuiFilesClient(<T,>(body: object) => connection.request<T>('request', body),
      connection.mappingStreams.open),
    snapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => { active = true; connection.start(); connection.retryNow(); },
    stop: () => { active = false; generation += 1; clearTimeout(timer); connection.stop(); update({ ready: false }); },
  };
}
