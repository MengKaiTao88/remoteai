// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposerBridge } from './composerBridge';
import { activateOfficialConversation } from './officialConversation';
import { GuiController } from './controller';
import { guiApi } from '../../../../../shared/conversation/api';
import type { ModelSettingsApi, ModelSettingsSnapshot } from './threadModelSettings';
import type { Model } from '../../../../../shared/conversation/types';
import { ChatController } from '../../../../../shared/remote-chat/client/controller';
import { COMPOSER_EVENT, composerThreadId } from '../../../../../shared/remote-chat/composer';
import { emptyQueue } from '../../../../../shared/remote-chat/queue';
import { historyDelta } from '../../../../../shared/remote-chat/historySync';
import { initializeBackendScope } from './backendScope';
import { invoke } from '../../../../../shared/platform/localBackend';
import type { ConnectionEvents } from '../../../../../shared/remote-chat/client/connection';

vi.mock('../../../../../shared/conversation/api', () => ({ guiApi: { request: vi.fn(), connect: vi.fn(), subscribe: vi.fn() } }));
vi.mock('./officialConversation', () => ({ activateOfficialConversation: vi.fn() }));
vi.mock('../../../../../shared/platform/localBackend', async importOriginal => ({ ...await importOriginal<typeof import('../../../../../shared/platform/localBackend')>(),
  hasLocalBackend: true, invoke: vi.fn() }));
const models: Model[] = [{ id: 'model', model: 'model', displayName: 'Model', isDefault: true,
  defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'high', 'xhigh'].map(reasoningEffort =>
    ({ reasoningEffort, description: '' })) }];
let pc: GuiController;
let bridge: ComposerBridge;
let saved: Map<string | null, ModelSettingsSnapshot>;
let api: ModelSettingsApi;
let cleanup: (() => void)[];

beforeEach(async () => {
  localStorage.clear(); vi.resetAllMocks(); cleanup = []; saved = new Map();
  vi.mocked(invoke).mockResolvedValue({ backend: 'gui', officialAvailable: true });
  await initializeBackendScope();
  const listeners = new Set<(snapshot: ModelSettingsSnapshot) => void>();
  api = {
    read: vi.fn(async threadId => saved.get(threadId) ?? { threadId, selection: null, revision: 0 }),
    write: vi.fn(async (threadId, selection) => {
      const snapshot = { threadId, selection, revision: (saved.get(threadId)?.revision ?? 0) + 1 };
      saved.set(threadId, snapshot); listeners.forEach(listener => listener(snapshot)); return snapshot;
    }),
    subscribe: async listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  vi.mocked(guiApi.request).mockImplementation(async request => request.operation === 'read'
    ? { thread: { id: request.threadId, cwd: '', preview: '', updatedAt: 1 } } : { data: models, nextCursor: null });
  pc = new GuiController(); await pc.setModels(models);
  cleanup.push(pc.modelSettings.start(api));
  bridge = new ComposerBridge(); cleanup.push(bridge.attach(pc));
  await pc.modelSettings.ready(null);
});
afterEach(() => { cleanup.forEach(stop => stop()); pc.dispose(); });

it('does not acknowledge a local permission preference for an official conversation with missing permission metadata', async () => {
  vi.mocked(invoke).mockResolvedValue({ backend: 'official', officialAvailable: true });
  await initializeBackendScope();
  saved.set('phone', { threadId: 'phone', selection: { model: 'model', effort: 'high' }, revision: 1 });
  api.writeAccess = vi.fn().mockRejectedValue(new Error('owner did not confirm'));
  await expect(bridge.update({ access: 'workspace-write' }, 'phone')).rejects.toThrow('owner did not confirm');
  expect(api.writeAccess).toHaveBeenCalledWith('phone', 'workspace-write');
  expect(saved.get('phone')?.access).toBeUndefined();
});

it('retains official permission authority while a model selection is being saved', async () => {
  saved.set('phone', { threadId: 'phone', selection: { model: 'model', effort: 'high' },
    access: 'danger-full-access', revision: 1 });
  await pc.modelSettings.ready('phone');
  let finish!: (snapshot: ModelSettingsSnapshot) => void;
  vi.mocked(api.write).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  pc.modelSettings.change({ effort: 'low' }, 'phone');
  expect(pc.modelSettings.access('phone')).toBe('danger-full-access');
  expect(pc.modelSettings.managesAccess('phone')).toBe(true);
  finish({ threadId: 'phone', selection: { model: 'model', effort: 'low' }, access: 'danger-full-access', revision: 2 });
  await pc.modelSettings.ready('phone');
});

it('publishes official access to remote clients and applies edits to their original conversation', async () => {
  saved.set('pc', { threadId: 'pc', selection: { model: 'model', effort: 'low' }, access: 'workspace-write', revision: 1 });
  saved.set('phone', { threadId: 'phone', selection: { model: 'model', effort: 'high' }, access: 'danger-full-access', revision: 1 });
  api.writeAccess = vi.fn(async (threadId, access) => {
    const snapshot = { ...saved.get(threadId)!, access, revision: 2 };
    saved.set(threadId, snapshot); return snapshot;
  });
  await pc.select('pc'); await pc.modelSettings.ready('pc');
  expect((await bridge.read('phone')).settings.access).toBe('danger-full-access');
  const result = await bridge.update({ access: 'read-only' }, 'phone');
  expect(result.settings.access).toBe('read-only');
  expect(api.writeAccess).toHaveBeenCalledWith('phone', 'read-only');
  expect(pc.getSnapshot()).toMatchObject({ selected: 'pc', settings: { access: 'workspace-write' } });
});

it('reads phone model settings without activating a native conversation window', async () => {
  const ready = vi.spyOn(pc.modelSettings, 'ready');
  await expect(bridge.read('phone')).resolves.toMatchObject({ threadId: 'phone' });
  expect(activateOfficialConversation).not.toHaveBeenCalled();
  expect(ready).toHaveBeenCalledWith('phone');
  await bridge.read('phone');
  expect(activateOfficialConversation).not.toHaveBeenCalled();
});

it('waits for official activation only when an existing phone conversation is sent', async () => {
  let activated!: () => void;
  vi.mocked(activateOfficialConversation).mockImplementationOnce(() => new Promise(resolve => { activated = resolve; }));
  const ready = vi.spyOn(pc.modelSettings, 'ready');
  const reading = bridge.validateSend({ threadId: 'phone' });
  await vi.waitFor(() => expect(activateOfficialConversation).toHaveBeenCalledWith('phone'));
  expect(ready).not.toHaveBeenCalledWith('phone');
  activated();
  await expect(reading).resolves.toMatchObject({ model: 'model' });
  expect(ready).toHaveBeenCalledWith('phone');
});

it('isolates phone settings from the PC conversation and its new-conversation defaults', async () => {
  await pc.select('pc'); pc.settings({ effort: 'low' });
  await bridge.update({ effort: 'high' }, 'phone');
  expect(pc.getSnapshot()).toMatchObject({ selected: 'pc', settings: { effort: 'low' } });
  expect(saved.get('phone')?.selection?.effort).toBe('high');
  const events = vi.fn(); cleanup.push(bridge.subscribe(events));
  pc.newConversation(); await pc.modelSettings.ready(null);
  expect((await bridge.read('phone')).settings.effort).toBe('high');
  expect(events.mock.calls.some(([snapshot]) => snapshot.threadId === 'phone' && snapshot.settings.effort === 'low'))
    .toBe(false);
  await pc.select('phone');
  expect(pc.getSnapshot().settings.effort).toBe('high');
});

it('inherits the current choice when starting a new PC conversation and persists it', async () => {
  await pc.select('pc'); pc.settings({ effort: 'xhigh' }); await pc.modelSettings.ready('pc');
  pc.newConversation();
  expect((await bridge.read(null)).settings.effort).toBe('xhigh');
  expect(saved.get(null)?.selection?.effort).toBe('xhigh');
  expect(saved.get('pc')?.selection?.effort).toBe('xhigh');
});

it('waits for a slow save instead of acknowledging an unpersisted remote choice', async () => {
  await bridge.read('phone');
  let finish!: (snapshot: ModelSettingsSnapshot) => void;
  vi.mocked(api.write).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let acknowledged = false;
  const update = bridge.update({ effort: 'high' }, 'phone').then(result => { acknowledged = true; return result; });
  await vi.waitFor(() => expect(api.write).toHaveBeenCalled());
  await pc.select('another');
  expect(acknowledged).toBe(false);
  expect(pc.getSnapshot().selected).toBe('another');
  finish({ threadId: 'phone', selection: { model: 'model', effort: 'high' }, revision: 1 });
  expect((await update).settings.effort).toBe('high');
});

it('rejects a failed remote save while retaining the choice for a later retry', async () => {
  vi.mocked(api.write).mockRejectedValueOnce(new Error('private storage detail'));
  await expect(bridge.update({ effort: 'high' }, 'phone')).rejects.toThrow('模型设置暂未同步');
  expect(pc.modelSettings.selection('phone').effort).toBe('high');
  await expect(bridge.update({ effort: 'xhigh' }, 'phone')).resolves.toMatchObject({
    threadId: 'phone', settings: { effort: 'xhigh' },
  });
  await expect(bridge.update({ effort: 'xhigh' }, 'another')).resolves.toMatchObject({ threadId: 'another' });
});

async function connectPhone(request: <T>(method: string, body?: unknown) => Promise<T>) {
  let phoneEvents!: ConnectionEvents;
  const phone = new ChatController(events => {
    phoneEvents = events;
    return { request, start: () => { events.mode('relay'); events.ready(); }, stop: () => {} };
  });
  cleanup.push(() => phone.stop());
  cleanup.push(bridge.subscribe(snapshot => phoneEvents.event({ method: COMPOSER_EVENT, params: snapshot })));
  phone.start(); await vi.waitFor(() => expect(phone.snapshot().ready).toBe(true));
  return phone;
}

it('confirms repeated permission edits through the full remote client instead of retaining a busy snapshot', async () => {
  const thread = { id: 'official-phone', cwd: '', preview: '', updatedAt: 1, turns: [] };
  saved.set(thread.id, { threadId: thread.id, selection: { model: 'model', effort: 'high' },
    access: 'danger-full-access', revision: 1 });
  api.writeAccess = vi.fn(async (threadId, access) => {
    const snapshot = { ...saved.get(threadId)!, access, revision: saved.get(threadId)!.revision + 1 };
    saved.set(threadId, snapshot); return snapshot;
  });
  const request = vi.fn(async (method: string, body?: Record<string, unknown>) => {
    if (method === 'connect') return [];
    if (body?.operation === 'models') {
      const composer = await bridge.read(composerThreadId(body.threadId));
      return { data: models, nextCursor: null, composer };
    }
    if (body?.operation === 'composerSet') return bridge.update(body.settings, composerThreadId(body.threadId));
    if (body?.operation === 'syncHistory') return historyDelta(thread);
    if (body?.operation === 'queueRead') return emptyQueue();
    return { data: [], nextCursor: null };
  });
  const phone = await connectPhone(request as <T>(method: string, body?: unknown) => Promise<T>);
  await phone.select(thread);
  await vi.waitFor(() => expect(phone.snapshot().settingsBusy).toBe(false));
  for (const access of ['workspace-write', 'danger-full-access', 'read-only', 'danger-full-access'] as const) {
    await phone.setSettings({ access });
    await vi.waitFor(() => expect(phone.snapshot().settingsBusy, phone.snapshot().settingsError).toBe(false));
    expect(saved.get(thread.id)?.access).toBe(access);
    expect(phone.snapshot().settings.access).toBe(access);
  }
  expect(api.writeAccess).toHaveBeenCalledTimes(4);
});

it('persists the phone-created selection before sending and keeps it after PC navigation', async () => {
  const created = { id: 'phone-created', cwd: '', preview: '', updatedAt: 1, turns: [] };
  const request = vi.fn(async (method: string, body?: Record<string, unknown>) => {
    if (method === 'connect') return [];
    if (body?.operation === 'models') {
      const composer = await bridge.read(composerThreadId(body.threadId));
      return { data: models, nextCursor: null, composer };
    }
    if (body?.operation === 'composerSet') return bridge.update(body.settings, composerThreadId(body.threadId));
    if (body?.operation === 'start') return { thread: created };
    if (body?.operation === 'send') {
      expect(saved.get(created.id)?.selection?.effort).toBe('high');
      expect(body.effort).toBe('high');
      return {};
    }
    if (body?.operation === 'syncHistory') return historyDelta(created);
    if (body?.operation === 'queueRead' || body?.operation === 'queueEnqueue') return emptyQueue();
    return { data: [], nextCursor: null };
  });
  const phone = await connectPhone(request as <T>(method: string, body?: unknown) => Promise<T>);
  await phone.setSettings({ effort: 'high', access: 'danger-full-access' });
  await vi.waitFor(() => expect(phone.snapshot().settingsBusy).toBe(false));
  await pc.select('pc');
  expect(pc.getSnapshot().settings.effort).toBe('low');
  expect(await phone.send({ text: 'phone probe', access: phone.snapshot().settings.access })).toBe(true);
  expect(request).toHaveBeenCalledWith('request', expect.objectContaining({
    operation: 'start', access: 'danger-full-access',
  }));
  pc.newConversation(); await pc.modelSettings.ready(null);
  expect(phone.snapshot().settings.effort).toBe('high');
  await pc.select(created.id);
  expect(pc.getSnapshot().settings.effort).toBe('high');
  expect(await phone.send({ text: 'follow up', access: phone.snapshot().settings.access })).toBe(true);
  expect(request).toHaveBeenCalledWith('request', expect.objectContaining({ operation: 'queueEnqueue',
    threadId: created.id, model: 'model', effort: 'high', access: 'danger-full-access' }));
  request.mockClear();
  phone.back();
  await vi.waitFor(() => expect(phone.snapshot().settingsBusy).toBe(false));
  expect(phone.snapshot().settings.access).toBe('danger-full-access');
  expect(request).toHaveBeenCalledWith('request', expect.objectContaining({ operation: 'composerSet',
    threadId: null, settings: expect.objectContaining({ access: 'danger-full-access' }) }));
});

it('restores the last phone permission for new conversations after the PC reopens', async () => {
  await bridge.update({ access: 'danger-full-access' }, 'phone');
  const reopened = new GuiController();
  const restoredBridge = new ComposerBridge();
  await reopened.setModels(models);
  cleanup.push(restoredBridge.attach(reopened)); cleanup.push(() => reopened.dispose());
  expect((await restoredBridge.read(null)).settings.access).toBe('danger-full-access');
});
