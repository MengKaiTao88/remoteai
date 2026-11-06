// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { initializeBackendScope, backendSnapshot, watchBackendScope, switchConversationBackend,
  consumeBackendModelRefresh, type BackendSnapshot } from './backendScope';
import { initialState, savePreferences } from './preferences';
import { invoke } from '../../../../../shared/platform/localBackend';
import { subscribeGuiEvent } from '../../../../../shared/conversation/webEvents';

vi.mock('../../../../../shared/conversation/webEvents', () => ({ subscribeGuiEvent: vi.fn(async () => vi.fn()) }));

vi.mock('../../../../../shared/platform/localBackend', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../shared/platform/localBackend')>(),
  hasLocalBackend: true, invoke: vi.fn(),
}));

afterEach(async () => {
  vi.mocked(invoke).mockResolvedValue({ backend: 'gui', officialAvailable: false });
  await initializeBackendScope(); consumeBackendModelRefresh();
  localStorage.clear(); sessionStorage.clear(); vi.resetAllMocks();
});

it('discovers models once after changing source without adding discovery to an ordinary reload', async () => {
  vi.mocked(invoke).mockResolvedValue({ backend: 'gui', officialAvailable: true });
  await initializeBackendScope();
  expect(consumeBackendModelRefresh()).toBe(false);
  vi.mocked(invoke).mockResolvedValue({ backend: 'official', officialAvailable: true });
  await initializeBackendScope();
  expect(consumeBackendModelRefresh()).toBe(true);
  expect(consumeBackendModelRefresh()).toBe(false);
  await initializeBackendScope();
  expect(consumeBackendModelRefresh()).toBe(false);
  vi.mocked(invoke).mockResolvedValue({ backend: 'gui', officialAvailable: true });
  await initializeBackendScope();
  expect(consumeBackendModelRefresh()).toBe(true);
});

it('keeps GUI and official last selections and permission preferences in separate scopes', async () => {
  vi.mocked(invoke).mockResolvedValue({ backend: 'gui', officialAvailable: true });
  await initializeBackendScope();
  const gui = initialState(); gui.selected = 'gui-thread';
  gui.settings.access = 'workspace-write'; savePreferences(gui);
  vi.mocked(invoke).mockResolvedValue({ backend: 'official', officialAvailable: true });
  await initializeBackendScope();
  expect(initialState().selected).toBeNull();
  const official = initialState(); official.selected = 'official-thread';
  official.settings.access = 'read-only'; savePreferences(official);
  vi.mocked(invoke).mockResolvedValue({ backend: 'gui', officialAvailable: true });
  await initializeBackendScope();
  expect(initialState()).toMatchObject({ selected: 'gui-thread', settings: { access: 'workspace-write' } });
  vi.mocked(invoke).mockResolvedValue({ backend: 'official', officialAvailable: true });
  await initializeBackendScope();
  expect(initialState()).toMatchObject({ selected: 'official-thread', settings: { access: 'read-only' } });
});

it('retains GUI compatibility when an older host has no mode selection command', async () => {
  vi.mocked(invoke).mockRejectedValue('unknown command');
  await initializeBackendScope();
  expect(backendSnapshot()).toEqual({ backend: 'gui', officialAvailable: false });
});

it('ignores replayed scope changes and reloads once for a new source generation', async () => {
  vi.mocked(invoke).mockResolvedValue({ backend: 'gui', revision: 10, officialAvailable: true });
  await initializeBackendScope();
  const reload = vi.fn(); await watchBackendScope(reload);
  const receive = vi.mocked(subscribeGuiEvent).mock.calls[0][1] as (value: BackendSnapshot) => void;
  receive({ backend: 'official', revision: 9, officialAvailable: true });
  expect(reload).not.toHaveBeenCalled();
  receive({ backend: 'official', revision: 11, officialAvailable: true });
  receive({ backend: 'gui', revision: 12, officialAvailable: true });
  expect(reload).toHaveBeenCalledOnce();
});

it('does not change sources when the current outbox cannot be saved', async () => {
  const failure = new Error('outbox unavailable');
  await expect(switchConversationBackend('official', async () => { throw failure; })).rejects.toBe(failure);
  expect(invoke).not.toHaveBeenCalled();
});
