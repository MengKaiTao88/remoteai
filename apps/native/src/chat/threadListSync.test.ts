import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatController } from '../../../../shared/remote-chat/client/controller';
import type { ChatConnection, ConnectionEvents } from '../../../../shared/remote-chat/client/connection';
import type { ListResponse, Thread } from './types';
import { HISTORY_CHANGED, historyDelta } from '../../../../shared/remote-chat/historySync';

const thread: Thread = { id: 'chat', name: 'Original', preview: '', cwd: '/project', updatedAt: 1 };
let controller: ChatController;
let events: ConnectionEvents;
const request = vi.fn<ChatConnection['request']>();

beforeEach(async () => {
  request.mockReset().mockImplementation(async (method, body) => {
    if (method === 'connect') return [];
    const operation = (body as { operation?: string })?.operation;
    if (operation === 'models') return { data: [{ id: 'model', model: 'model', displayName: 'Model',
      isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [] }], nextCursor: null };
    return { data: operation === 'list' ? [thread] : [], nextCursor: null };
  });
  controller = new ChatController(callbacks => {
    events = callbacks;
    return { start() { events.mode('relay'); events.ready(); }, stop() {},
      request: <T>(...args: Parameters<ChatConnection['request']>) => request(...args) as Promise<T> };
  });
  controller.start();
  await vi.waitFor(() => expect(controller.snapshot().ready).toBe(true));
  request.mockClear();
  vi.useFakeTimers();
});
afterEach(() => { controller.stop(); vi.useRealTimers(); });

function pendingPage() {
  let finish!: (value: ListResponse<Thread>) => void;
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  return (data = [thread]) => finish({ data, nextCursor: null });
}

function notify(count = 1) {
  for (let index = 0; index < count; index++) events.event({ method: HISTORY_CHANGED,
    params: { threadId: thread.id, reason: 'thread/resumed' } });
}

it('coalesces event bursts and applies an in-flight page before one trailing refresh', async () => {
  const finish = pendingPage();
  notify(100);
  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(150);
  expect(request).toHaveBeenCalledTimes(1);
  expect(controller.snapshot()).toMatchObject({ loading: true, listRefreshing: false, threads: [thread] });
  notify(100);
  await vi.advanceTimersByTimeAsync(1000);
  expect(request).toHaveBeenCalledTimes(1);
  const incoming = { ...thread, name: 'First response' };
  finish([incoming]);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.snapshot().threads).toEqual([incoming]);
  const latest = { ...thread, name: 'Latest response' };
  request.mockResolvedValueOnce({ data: [latest], nextCursor: null });
  await vi.advanceTimersByTimeAsync(150);
  expect(request).toHaveBeenCalledTimes(2);
  expect(controller.snapshot()).toMatchObject({ loading: false, listRefreshing: false, threads: [latest] });
  expect(vi.getTimerCount()).toBe(0);
});

it('coalesces manual pulls into one fresh request after a pending automatic request', async () => {
  const finish = pendingPage();
  notify();
  await vi.advanceTimersByTimeAsync(150);
  const first = controller.list();
  const second = controller.list();
  expect(first).toBe(second);
  expect(request).toHaveBeenCalledTimes(1);
  expect(controller.snapshot().listRefreshing).toBe(true);
  const latest = { ...thread, name: 'Updated after the automatic request started' };
  request.mockResolvedValueOnce({ data: [latest], nextCursor: null });
  finish();
  await Promise.all([first, second]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(controller.snapshot()).toMatchObject({ loading: false, listRefreshing: false, threads: [latest] });
});

it('keeps a newer archive filter when an older request arrives late', async () => {
  const finish = pendingPage();
  const previous = controller.list();
  const archived = { ...thread, id: 'archived' };
  request.mockResolvedValueOnce({ data: [archived], nextCursor: null });
  await controller.list({ archived: true });
  finish();
  await previous;
  expect(controller.snapshot()).toMatchObject({ archived: true, threads: [archived], loading: false });
});

it('waits for pagination before refreshing notifications and does not show pull progress for more pages', async () => {
  Object.assign(controller.snapshot(), { cursor: 'next' });
  const finish = pendingPage();
  const more = controller.list({ more: true });
  notify(20);
  await vi.advanceTimersByTimeAsync(1000);
  expect(request).toHaveBeenCalledTimes(1);
  expect(controller.snapshot().listRefreshing).toBe(false);
  const older = { ...thread, id: 'older' };
  finish([older]);
  await more;
  expect(controller.snapshot().threads).toEqual([thread, older]);
  await vi.advanceTimersByTimeAsync(150);
  expect(request).toHaveBeenCalledTimes(2);
});

it('preserves a scheduled first-page refresh when pagination starts before its timer', async () => {
  Object.assign(controller.snapshot(), { cursor: 'next' });
  notify();
  const finish = pendingPage();
  const more = controller.list({ more: true });
  finish([{ ...thread, id: 'older' }]);
  await more;
  const latest = { ...thread, id: 'newest' };
  request.mockResolvedValueOnce({ data: [latest, thread], nextCursor: null });
  await vi.advanceTimersByTimeAsync(150);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1][1]).toMatchObject({ operation: 'list', cursor: undefined });
  expect(controller.snapshot().threads).toEqual([latest, thread]);
});

it.each(['thread/name/updated', 'turn/started', 'turn/completed'])(
  'does not let a slow list roll back a newer %s event', async method => {
    const finish = pendingPage();
    const pending = controller.list({ background: true, force: true });
    events.event({ method, params: { threadId: thread.id, threadName: 'Renamed',
      turn: { id: 'turn', status: method === 'turn/started' ? 'inProgress' : 'completed', items: [] } } });
    const live = controller.snapshot().threads;
    finish();
    await pending;
    expect(controller.snapshot().threads).toEqual(live);
    await vi.advanceTimersByTimeAsync(150);
    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().threads).toEqual(live);
  },
);

it('refreshes ordering after a turn completes in an existing unselected chat', async () => {
  const recent = { ...thread, id: 'recent', updatedAt: 2 };
  request.mockResolvedValueOnce({ data: [recent, thread], nextCursor: null });
  await controller.list();
  request.mockClear();
  events.event({ method: 'turn/completed', params: { threadId: thread.id,
    turn: { id: 'turn', status: 'completed', completedAt: 3, items: [] } } });
  const latest = { ...thread, updatedAt: 3, status: { type: 'idle' } };
  await vi.advanceTimersByTimeAsync(150);
  expect(controller.snapshot().threads).toEqual([latest, recent]);
  expect(request).not.toHaveBeenCalled();
});

it('keeps newly started chats while applying other useful rows from a slow page', async () => {
  const finish = pendingPage();
  const pending = controller.list({ background: true, force: true });
  const created = { ...thread, id: 'created', updatedAt: 3 };
  events.event({ method: 'thread/started', params: { thread: created } });
  const incoming = { ...thread, updatedAt: 2 };
  finish([incoming]);
  await pending;
  expect(controller.snapshot().threads).toEqual([created, incoming]);
  await vi.advanceTimersByTimeAsync(150);
  expect(request).toHaveBeenCalledTimes(1);
  expect(controller.snapshot().threads).toEqual([created, incoming]);
});

it('discards an older archived page when sending creates a new active chat', async () => {
  Object.assign(controller.snapshot(), { archived: true, settingsBusy: false });
  const finish = pendingPage();
  const pending = controller.list({ background: true, force: true });
  const created = { ...thread, id: 'created', turns: [] };
  request.mockImplementation(async (_method, body) => {
    const input = body as { operation: string };
    if (input.operation === 'start') return { thread: created };
    if (input.operation === 'syncHistory') return historyDelta(created);
    if (input.operation === 'list') return { data: [created], nextCursor: null };
    return {};
  });
  expect(await controller.send({ text: 'Hello', access: 'workspace-write' })).toBe(true);
  finish([{ ...thread, id: 'archived' }]);
  await pending;
  expect(controller.snapshot()).toMatchObject({ archived: false, loading: false });
  expect(controller.snapshot().threads.map(entry => entry.id)).toEqual(['created', thread.id]);
  await vi.advanceTimersByTimeAsync(150);
  expect(controller.snapshot().threads.map(entry => entry.id)).toEqual(['created', thread.id]);
});

it('waits for pagination before fetching a fresh manual first page', async () => {
  Object.assign(controller.snapshot(), { cursor: 'next' });
  const finish = pendingPage();
  const more = controller.list({ more: true });
  const manual = controller.list();
  expect(request).toHaveBeenCalledTimes(1);
  const latest = { ...thread, id: 'latest' };
  request.mockResolvedValueOnce({ data: [latest], nextCursor: null });
  finish([{ ...thread, id: 'older' }]);
  await Promise.all([more, manual]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(controller.snapshot()).toMatchObject({ threads: [latest], loading: false, listRefreshing: false });
});

it.each(['stop', 'disconnect', 'filter'] as const)('cancels a queued manual refresh on %s', async action => {
  const finish = pendingPage();
  const background = controller.list({ background: true, force: true });
  const manual = controller.list();
  if (action === 'stop') controller.stop();
  else if (action === 'disconnect') events.mode('offline');
  else await controller.list({ archived: true });
  finish([{ ...thread, name: 'Obsolete' }]);
  await Promise.all([background, manual]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(request).toHaveBeenCalledTimes(action === 'filter' ? 2 : 1);
  expect(controller.snapshot()).toMatchObject({ threads: [thread], loading: false, listRefreshing: false });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['stop', 'disconnect'] as const)('cancels pending work on %s', async action => {
  const finish = pendingPage();
  const pending = controller.list();
  notify();
  if (action === 'stop') controller.stop();
  else events.mode('offline');
  finish([{ ...thread, name: 'Stale' }]);
  await pending;
  await vi.advanceTimersByTimeAsync(1000);
  expect(request).toHaveBeenCalledTimes(1);
  expect(controller.snapshot()).toMatchObject({ threads: [thread], loading: false, listRefreshing: false });
  expect(vi.getTimerCount()).toBe(0);
});

it('clears failed refresh progress and allows an explicit retry', async () => {
  request.mockRejectedValueOnce(new Error('Refresh unavailable'));
  await controller.list();
  expect(controller.snapshot()).toMatchObject({ loading: false, listRefreshing: false, threads: [thread] });
  await controller.list();
  expect(request).toHaveBeenCalledTimes(2);
});
