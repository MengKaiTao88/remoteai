import { hasLocalBackend, invoke } from '../../../../../shared/platform/localBackend';
import { setConversationScope } from '../../../../../shared/platform/conversationScope';
import { subscribeGuiEvent } from '../../../../../shared/conversation/webEvents';

export type ConversationBackend = 'gui' | 'official';
export interface BackendSnapshot { backend: ConversationBackend; officialAvailable: boolean; revision?: number }
let snapshot: BackendSnapshot = { backend: 'gui', officialAvailable: false };
const BACKEND_SESSION_KEY = 'codex-switch:conversation-backend';
let refreshModels = false;

/** Read the native scope before constructing the shared desktop/phone host controller. */
export async function initializeBackendScope() {
  if (!hasLocalBackend) return;
  try {
    snapshot = await invoke<BackendSnapshot>('codex_gui_backend');
    try {
      const previous = sessionStorage.getItem(BACKEND_SESSION_KEY);
      refreshModels ||= previous !== null && previous !== snapshot.backend;
      sessionStorage.setItem(BACKEND_SESSION_KEY, snapshot.backend);
    } catch { /* Storage restrictions leave the existing explicit model retry available. */ }
    setConversationScope(snapshot.revision === undefined ? undefined : {
      backend: snapshot.backend, revision: snapshot.revision,
    });
  }
  catch { /* Older servers and browser previews retain the existing GUI scope. */ }
}

export function watchBackendScope(reload: () => void = () => window.location.reload()) {
  let reloading = false;
  return subscribeGuiEvent<BackendSnapshot>('codex-gui-backend-changed', next => {
    if (reloading || next.revision === undefined || next.revision <= (snapshot.revision ?? 0)) return;
    reloading = true; reload();
  });
}

export function backendSnapshot() { return snapshot; }
/** A source switch is an explicit discovery action, while an ordinary launch remains cache-only. */
export function consumeBackendModelRefresh() {
  const refresh = refreshModels;
  refreshModels = false;
  return refresh;
}
export async function switchConversationBackend(backend: ConversationBackend, saveQueue: () => Promise<void>) {
  await saveQueue();
  return invoke<BackendSnapshot>('codex_gui_switch_backend', { backend });
}
export function backendStorageKey(key: string) {
  return snapshot.backend === 'official' ? `${key}:official` : key;
}
