// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTotpEntries } from './useTotpEntries';
import { mergeTotpVaults, TOTP_CLOUD_SYNC_KEY, type TotpVault } from '../utils/totp';

const backend = vi.hoisted(() => ({ pullCloudTotp: vi.fn(), syncCloudTotp: vi.fn(),
  publishTotpChange: vi.fn(), subscribeToTotpChanges: vi.fn() }));
vi.mock('../api/backend', () => backend);
const empty = (): TotpVault => ({ entries: [], tombstones: [], modifiedAt: '1970-01-01T00:00:00.000Z' });
const draft = { issuer: 'Sync fixture', accountName: 'fixture@example.test', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1' as const, digits: 6 as const, period: 30 };
const remoteEntry = { ...draft, id: '10000000-0000-4000-8000-000000000001',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
let root: Root;
let manager: ReturnType<typeof useTotpEntries>;
let remote: TotpVault;
const notify = vi.fn();
const translate = ((key: string) => key) as Parameters<typeof useTotpEntries>[0]['t'];
function Fixture({ authenticated = true, identity = 'fixture' }) {
  manager = useTotpEntries({ cloudAuthenticated: authenticated, cloudIdentity: identity, notify, t: translate });
  return null;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  localStorage.clear();
  localStorage.setItem(TOTP_CLOUD_SYNC_KEY, 'true');
  remote = empty();
  backend.pullCloudTotp.mockImplementation(async () => structuredClone(remote));
  backend.syncCloudTotp.mockImplementation(async (vault: TotpVault) => {
    remote = mergeTotpVaults(remote, vault);
    return structuredClone(remote);
  });
  backend.publishTotpChange.mockResolvedValue(undefined);
  backend.subscribeToTotpChanges.mockReturnValue(() => undefined);
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  // jsdom dispatches queued localStorage events with zero-delay timeouts.
  vi.runOnlyPendingTimers();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('detects another client adding and deleting entries while already open', async () => {
  await act(async () => root.render(<Fixture />));
  remote = { entries: [remoteEntry], tombstones: [], modifiedAt: remoteEntry.updatedAt };
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(manager.entries.map(entry => entry.id)).toEqual([remoteEntry.id]);
  remote = { entries: [], tombstones: [{ id: remoteEntry.id, deletedAt: '2026-02-01T00:00:00.000Z' }],
    modifiedAt: '2026-02-01T00:00:00.000Z' };
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(manager.entries).toEqual([]);
  expect(backend.syncCloudTotp).not.toHaveBeenCalled();
});

it('refreshes on focus and reconnect without waiting for the next interval', async () => {
  await act(async () => root.render(<Fixture />));
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(backend.pullCloudTotp).toHaveBeenCalledTimes(3);
});

it('keeps polling single flight and preserves edits made during a download', async () => {
  let release!: (vault: TotpVault) => void;
  backend.pullCloudTotp.mockReturnValueOnce(new Promise<TotpVault>(resolve => { release = resolve; }));
  await act(async () => root.render(<Fixture />));
  await act(async () => vi.advanceTimersByTime(90_000));
  expect(backend.pullCloudTotp).toHaveBeenCalledTimes(1);
  await act(async () => manager.addEntry(draft));
  await act(async () => release({ entries: [remoteEntry], tombstones: [], modifiedAt: remoteEntry.updatedAt }));
  expect(manager.entries).toHaveLength(2);
  expect(remote.entries).toHaveLength(2);
  expect(manager.syncing).toBe(false);
});

it('retries an offline upload and stops automatic checks when disabled', async () => {
  await act(async () => root.render(<Fixture />));
  backend.syncCloudTotp.mockRejectedValueOnce(new Error('offline'));
  await act(async () => manager.addEntry(draft));
  expect(manager.entries).toHaveLength(1);
  expect(remote.entries).toHaveLength(0);
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(remote.entries).toHaveLength(1);
  await act(async () => manager.setCloudSyncEnabled(false));
  const calls = backend.pullCloudTotp.mock.calls.length;
  await act(async () => { vi.advanceTimersByTime(60_000); window.dispatchEvent(new Event('focus')); });
  expect(backend.pullCloudTotp).toHaveBeenCalledTimes(calls);
});

it('ignores a response after logout and cancels queued uploads', async () => {
  let release!: (vault: TotpVault) => void;
  backend.pullCloudTotp.mockReturnValueOnce(new Promise<TotpVault>(resolve => { release = resolve; }));
  await act(async () => root.render(<Fixture />));
  await act(async () => manager.addEntry(draft));
  await act(async () => root.render(<Fixture authenticated={false} />));
  await act(async () => release({ entries: [remoteEntry], tombstones: [], modifiedAt: remoteEntry.updatedAt }));
  expect(manager.entries).toHaveLength(1);
  expect(backend.syncCloudTotp).not.toHaveBeenCalled();
});

it('still performs initial synchronization when StrictMode remounts effects', async () => {
  remote = { entries: [remoteEntry], tombstones: [], modifiedAt: remoteEntry.updatedAt };
  await act(async () => root.render(<StrictMode><Fixture /></StrictMode>));
  expect(manager.entries).toHaveLength(1);
  expect(manager.syncing).toBe(false);
});
