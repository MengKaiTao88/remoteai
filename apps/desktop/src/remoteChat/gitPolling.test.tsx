// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRemoteGit } from '../../../../shared/remote-chat/useRemoteGit';
import { createAsyncGitFixture } from '../../../../shared/remote-chat/testing/gitFixture';
import type { GitChanges } from '../../../../shared/remote-chat/gitTypes';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const client = createAsyncGitFixture();
let root: ReturnType<typeof createRoot>;
let panel: ReturnType<typeof useRemoteGit>;
function Fixture({ active = true, connected = true }: { active?: boolean; connected?: boolean }) {
  panel = useRemoteGit({ client, cwd: '/project', active, connected, refreshInterval: 1000 });
  return null;
}
const tick = (ms = 1000) => act(async () => vi.advanceTimersByTimeAsync(ms));
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(client, createAsyncGitFixture());
  vi.spyOn(client, 'changes'); vi.spyOn(client, 'action');
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.useRealTimers(); });

it('loads immediately and polls silently while preserving drafts, selection, notices and older history', async () => {
  await act(async () => root.render(<Fixture />));
  expect(client.changes).toHaveBeenCalledTimes(1);
  await act(async () => panel.action('fetch'));
  await act(async () => {
    panel.toggle(panel.changes!.files[0]); panel.setMessage('unfinished draft');
    panel.setDetail({ kind: 'diff', path: 'src/app.ts', title: 'app' });
  });
  await act(async () => panel.more());
  const commits = panel.commits.map(row => row.hash);
  await act(async () => panel.action('fetch'));
  await tick(999);
  const calls = vi.mocked(client.changes).mock.calls.length;
  await tick(1);
  expect(client.changes).toHaveBeenCalledTimes(calls + 1);
  expect(panel.busy).toBe(false);
  expect(panel.message).toBe('unfinished draft');
  expect(panel.selected).toEqual({ 'src/app.ts': 'app-v1' });
  expect(panel.commits.map(row => row.hash)).toEqual(commits);
  expect(panel.notice).toBe('已获取远程记录');
  await act(async () => panel.setDetail({ kind: 'diff', path: 'src/app.ts', title: 'app' }));
  await tick();
  expect(panel.detail?.kind).toBe('diff');
});

it('keeps slow reads single-flight and runs a clicked action after the background read finishes', async () => {
  await act(async () => root.render(<Fixture />));
  const changes = panel.changes!;
  let finish!: (value: GitChanges) => void;
  vi.mocked(client.changes).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await tick(5000);
  expect(client.changes).toHaveBeenCalledTimes(2);
  expect(panel.busy).toBe(false);
  let action!: Promise<void>;
  await act(async () => { action = panel.action('fetch'); });
  expect(panel.busy).toBe(true);
  expect(client.action).not.toHaveBeenCalled();
  await act(async () => { finish(changes); await action; });
  expect(client.action).toHaveBeenCalledTimes(1);
  expect(panel.notice).toBe('已获取远程记录');
});

it('waits for all reads after an error, drops stale selection, and pauses when hidden or disconnected', async () => {
  await act(async () => root.render(<Fixture />));
  await act(async () => panel.toggle(panel.changes!.files[0]));
  const next = structuredClone(panel.changes!);
  next.files[0].version = 'updated-externally';
  vi.mocked(client.changes).mockResolvedValue(next);
  let finish!: () => void;
  vi.spyOn(client, 'repository').mockRejectedValueOnce(new Error('unavailable'));
  const history = await client.history('/project', 0);
  vi.spyOn(client, 'history').mockImplementationOnce(() => new Promise(resolve => {
    finish = () => resolve(history);
  }));
  await tick(5000);
  expect(client.changes).toHaveBeenCalledTimes(2);
  await act(async () => finish());
  expect(panel.error).toBe('unavailable');
  await tick();
  expect(panel.error).toBe('');
  expect(panel.selected).toEqual({});
  const count = vi.mocked(client.changes).mock.calls.length;
  await act(async () => root.render(<Fixture active={false} />));
  await tick(5000);
  expect(client.changes).toHaveBeenCalledTimes(count);
  await act(async () => root.render(<Fixture connected={false} />));
  await tick(5000);
  expect(client.changes).toHaveBeenCalledTimes(count);
  await act(async () => root.render(<Fixture />));
  expect(client.changes).toHaveBeenCalledTimes(count + 1);
});
