// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUpdateSharing, type SharingStatus } from './useUpdateSharing';

const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => api);
let root: Root;
let hook: ReturnType<typeof useUpdateSharing>;
const status: SharingStatus = { preferences: { scope: 'own', uploadKibPerSecond: 1024,
  unmeteredOnly: true, prepareAndroid: false }, networkAllowed: true,
  peerBytes: 0, originBytes: 0, uploadedBytes: 0, retries: 0, failures: 0 };
function Harness() { hook = useUpdateSharing(true); return null; }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });

it('keeps polling single-flight and prevents a stale read from undoing a saved scope', async () => {
  let finish!: (value: SharingStatus) => void;
  api.invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(api.invoke).toHaveBeenCalledOnce();
  const changed = { ...status, preferences: { ...status.preferences, scope: 'off' as const } };
  api.invoke.mockResolvedValueOnce(changed);
  await act(async () => hook.save(changed.preferences));
  await act(async () => finish(status));
  expect(hook.status?.preferences.scope).toBe('off');
});

it('keeps the previous settings when persistence fails', async () => {
  api.invoke.mockResolvedValueOnce(status);
  await act(async () => root.render(<Harness />));
  api.invoke.mockRejectedValueOnce(new Error('unavailable'));
  await act(async () => hook.save({ ...status.preferences, scope: 'everyone' }));
  expect(hook.status?.preferences.scope).toBe('own');
  expect(hook.error).toBe('save');
  expect(hook.saving).toBe(false);
});

it('clears a temporary read error after polling recovers', async () => {
  api.invoke.mockRejectedValueOnce(new Error('unavailable'));
  await act(async () => root.render(<Harness />));
  expect(hook.error).toBe('load');
  api.invoke.mockResolvedValueOnce(status);
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(hook.status).toEqual(status);
  expect(hook.error).toBeUndefined();
});
