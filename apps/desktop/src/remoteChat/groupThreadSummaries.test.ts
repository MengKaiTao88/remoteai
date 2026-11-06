import { beforeEach, expect, it, vi } from 'vitest';
import { readRemoteThreadList } from './threadList';
import { guiApi } from '../../../../shared/conversation/api';
import { emptyGrouping } from '../../../../shared/chat/groups/model';
import type { Thread } from '../../../../shared/conversation/types';
import { ThreadListCache } from '../../../../shared/remote-chat/client/threadListCache';

const fixture = vi.hoisted(() => ({ read: vi.fn(), snapshot: vi.fn(), sidebar: vi.fn(), backend: 'gui' }));
vi.mock('../pages/codexGui/backendScope', () => ({ backendSnapshot: () => ({ backend: fixture.backend }) }));
vi.mock('../pages/codexGui/session', () => ({ getGuiController: () => ({
  readThreadList: fixture.read, getSnapshot: fixture.snapshot,
}) }));
vi.mock('../pages/codexGui/sidebarBridge', () => ({ guiSidebar: { snapshot: fixture.sidebar } }));
vi.mock('../../../../shared/conversation/api', () => ({ guiApi: { request: vi.fn() } }));
const recent: Thread = { id: 'recent', name: 'Recent', preview: '', cwd: '/project', updatedAt: 1000 };
const older: Thread = { ...recent, id: 'older', name: 'Grouped chat', updatedAt: 1 };

beforeEach(() => {
  vi.resetAllMocks();
  fixture.backend = 'gui';
  fixture.snapshot.mockReturnValue({ grouping: { ...emptyGrouping(),
    groups: [{ id: 'group', name: 'Group', parentId: null }],
    threads: { older: 'group', recent: 'group', removed: null, orphan: 'missing' } } });
  fixture.read.mockResolvedValue({ data: [recent], nextCursor: 'next-page' });
  fixture.sidebar.mockReturnValue({ threads: { older: { running: true } } });
  vi.mocked(guiApi.request).mockResolvedValue([older, { ...recent, name: 'Stale index title' }]);
});

it('finds official grouped chats in later metadata pages without requesting the GUI-only index', async () => {
  fixture.backend = 'official';
  vi.mocked(guiApi.request).mockImplementation(async request => {
    if (request.operation !== 'list') throw new Error('Unsupported GUI operation');
    return request.cursor ? { data: [older] } : { data: [recent], nextCursor: 'older-page' };
  });
  const result = await readRemoteThreadList({ archived: false });
  expect(result).toEqual({ data: [recent, { ...older, status: { type: 'active' } }], nextCursor: 'next-page' });
  expect(guiApi.request).toHaveBeenCalledTimes(2);
  expect(vi.mocked(guiApi.request).mock.calls.every(([request]) => request.operation === 'list')).toBe(true);
});

it('includes old grouped chats in the first reply without draining recent pages or loading chat bodies', async () => {
  const result = await readRemoteThreadList({ archived: false });
  expect(result).toEqual({ data: [recent, { ...older, status: { type: 'active' } }], nextCursor: 'next-page' });
  expect(fixture.read).toHaveBeenCalledOnce();
  expect(guiApi.request).toHaveBeenCalledExactlyOnceWith({
    operation: 'groupThreadSummaries', threadIds: ['older', 'recent'], archived: false,
  });
});

it('keeps archived and search scopes separate and does not repeat the supplement on later pages', async () => {
  await readRemoteThreadList({ archived: true });
  expect(guiApi.request).toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
  vi.mocked(guiApi.request).mockClear();
  for (const query of [{ archived: false, cursor: 'next-page' }, { archived: false, search: 'unrelated' }]) {
    expect((await readRemoteThreadList(query)).data).toEqual([recent]);
  }
  expect(guiApi.request).not.toHaveBeenCalled();
});

it('keeps the first-page supplement when loading subsequent pages without duplicating grouped chats', async () => {
  const cache = new ThreadListCache(query => readRemoteThreadList({ ...query }));
  await cache.read({ archived: false });
  fixture.read.mockResolvedValueOnce({ data: [{ ...older, preview: 'Full summary' }], nextCursor: null });
  const result = await cache.read({ archived: false, cursor: 'next-page' });
  expect(result.data.map(thread => thread.id)).toEqual(['recent', 'older']);
  expect(result.data[1].preview).toBe('Full summary');
  expect(result.nextCursor).toBeNull();
  expect(guiApi.request).toHaveBeenCalledOnce();
});

it('skips empty groups and preserves ordinary pagination when the metadata index is unavailable', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(guiApi.request).mockRejectedValueOnce(new Error('index unavailable'));
  expect((await readRemoteThreadList({ archived: false })).data).toEqual([recent]);
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
  fixture.snapshot.mockReturnValue({ grouping: emptyGrouping() });
  vi.mocked(guiApi.request).mockClear();
  await readRemoteThreadList({ archived: false });
  expect(guiApi.request).not.toHaveBeenCalled();
});
