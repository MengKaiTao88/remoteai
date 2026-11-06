// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { readMembersPage, readMembersQuery } from '../../../../../shared/chat/groups/memberPaging';
import { createGuiGroups } from './groupActions';
import { initialState } from './preferences';
import { guiApi } from '../../../../../shared/conversation/api';
import * as backendScope from './backendScope';

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it('requests one bounded metadata page, including saved aliases and effective paths, without fetching all threads', async () => {
  localStorage.setItem('codex-switch:gui-projects', JSON.stringify([{ path: '/saved', name: 'Alias' }]));
  const state = { ...initialState(), projects: ['/recent'], projectOverrides: { older: '/moved' } };
  state.grouping.projects['/grouped'] = 'group';
  const response = { data: [], total: 200, page: 3, pageSize: 50 };
  const request = vi.spyOn(guiApi, 'request').mockResolvedValue(response);
  const groups = createGuiGroups({ snapshot: () => state, patch: vi.fn() });
  await expect(groups.membersPage!({ page: 3, pageSize: 50, search: ' older ' })).resolves.toEqual(response);
  expect(request).toHaveBeenCalledExactlyOnceWith({ operation: 'groupMembersPage', page: 3, pageSize: 50,
    search: 'older', projectOverrides: { older: '/moved' }, projects: [
      { path: '/recent', name: 'recent' }, { path: '/saved', name: 'Alias' }, { path: '/grouped', name: 'grouped' },
    ] });
});

it('rejects malformed paging and a pre-paging host response', () => {
  for (const query of [null, {}, { page: 0, pageSize: 20, search: '' }, { page: 1, pageSize: 10_000, search: '' },
    { page: 1.2, pageSize: 20, search: '' }, { page: 1, pageSize: 20, search: 'x'.repeat(1001) }]) {
    expect(() => readMembersQuery(query)).toThrow();
  }
  expect(() => readMembersPage({ revision: 1 })).toThrow('updateRemoteAiOnYourComputerAndTryAgain');
  expect(() => readMembersPage({ data: [], total: -1, page: 1, pageSize: 20 })).toThrow();
});

it('pages official metadata across recent and archived chats without the GUI-only paging operation', async () => {
  vi.spyOn(backendScope, 'backendSnapshot').mockReturnValue({ backend: 'official', officialAvailable: true });
  const state = { ...initialState(), projects: [], projectOverrides: { older: '/moved' } };
  const request = vi.spyOn(guiApi, 'request').mockImplementation(async input => {
    if (input.operation !== 'list') throw new Error('Unsupported GUI operation');
    if (input.archived) return { data: [{ id: 'archived', name: 'Find archived', cwd: '/archive' }] };
    if (input.cursor) return { data: [{ id: 'older', name: 'Find older', cwd: '/original' }] };
    return { data: [{ id: 'recent', name: 'Recent', cwd: '/recent' }], nextCursor: 'next' };
  });
  const groups = createGuiGroups({ snapshot: () => state, patch: vi.fn() });
  await expect(groups.membersPage!({ page: 99, pageSize: 20, search: ' find ' })).resolves.toEqual({
    data: [
      { kind: 'thread', id: 'older', title: 'Find older', cwd: '/moved', archived: false },
      { kind: 'thread', id: 'archived', title: 'Find archived', cwd: '/archive', archived: true },
    ], total: 2, page: 1, pageSize: 20,
  });
  expect(request.mock.calls.every(([input]) => input.operation === 'list')).toBe(true);
});
