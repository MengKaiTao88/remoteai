// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteChatHost } from './useChatHost';

const state = vi.hoisted(() => ({
  invoke: vi.fn(), created: vi.fn(), release: vi.fn(), retain: vi.fn(), connected: false,
  hosts: [] as { close: ReturnType<typeof vi.fn> }[],
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('./host', () => ({ ChatHost: class {
  close = vi.fn();
  constructor() { state.created(); state.hosts.push(this); }
} }));
vi.mock('../pages/codexGui/session', () => ({ retainGuiSession: () => {
  state.retain(); return state.release;
} }));
vi.mock('./mobileConnection', () => ({ mobileConnection: {
  getSnapshot: () => state.connected, setConnected: vi.fn(),
} }));

let root: Root;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.hosts = []; state.connected = false;
  state.invoke.mockResolvedValue({ restartRequired: false });
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it('rebuilds stalled IPC even before the first mobile session without restarting the GUI session', async () => {
  await act(async () => root.render(<RemoteChatHost />));
  state.invoke.mockResolvedValueOnce({ restartRequired: true });
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(state.invoke).toHaveBeenLastCalledWith('remote_chat_host_alive', {
    active: false, rendererId: expect.any(Number),
  });
  expect(state.hosts).toHaveLength(2);
  expect(state.hosts[0].close).toHaveBeenCalledOnce();
  expect(state.hosts[1].close).not.toHaveBeenCalled();
  expect(state.retain).toHaveBeenCalledOnce();
  expect(state.release).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(state.hosts).toHaveLength(2);
  const ids = state.invoke.mock.calls.map(([, request]) => request.rendererId);
  expect(new Set(ids).size).toBe(1);
});

it('keeps a healthy active connection and only polls once while a health check is pending', async () => {
  state.connected = true;
  let finish!: (status: { restartRequired: boolean }) => void;
  state.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<RemoteChatHost />));
  await act(async () => vi.advanceTimersByTimeAsync(40_000));
  expect(state.invoke).toHaveBeenCalledOnce();
  expect(state.invoke).toHaveBeenLastCalledWith('remote_chat_host_alive', {
    active: true, rendererId: expect.any(Number),
  });
  await act(async () => finish({ restartRequired: false }));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(state.invoke).toHaveBeenCalledTimes(2);
  expect(state.hosts).toHaveLength(1);
  expect(state.hosts[0].close).not.toHaveBeenCalled();
});

it('ignores a late recovery reply after unmount and releases the host and session', async () => {
  let finish!: (status: { restartRequired: boolean }) => void;
  state.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<RemoteChatHost />));
  await act(async () => root.render(null));
  await act(async () => finish({ restartRequired: true }));
  expect(state.hosts).toHaveLength(1);
  expect(state.hosts[0].close).toHaveBeenCalledOnce();
  expect(state.release).toHaveBeenCalledOnce();
  expect(state.invoke).toHaveBeenLastCalledWith('remote_chat_host_alive', {
    active: false, rendererId: expect.any(Number),
  });
  expect(vi.getTimerCount()).toBe(0);
});

it('closes phone transports when a mode switch reloads the view while retaining the native GUI session', async () => {
  await act(async () => root.render(<RemoteChatHost />));
  await act(async () => { window.dispatchEvent(new Event('beforeunload')); });
  expect(state.hosts[0].close).toHaveBeenCalledOnce();
  expect(state.release).not.toHaveBeenCalled();
});
