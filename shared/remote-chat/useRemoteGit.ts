import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitAction, GitChange, GitChanges, GitClient, GitCommit, GitDiff, GitHistory, GitRepository,
  GitStrategy } from './gitTypes';
import { toggleFiles } from './gitFiles';
import { GIT_ACTION_NOTICE } from './gitActions';
import { useGitFileList } from './useGitFileList';
import { gitErrorText, useGitRequests } from './useGitRequests';
import { readGitSnapshot, refreshGitHistory } from './gitSnapshot';

export type GitDetail = { kind: 'files'; commit: GitCommit }
  | { kind: 'diff'; path: string; commit?: GitCommit; title: string };

export function parentGitDetail(detail: GitDetail | null): GitDetail | null {
  return detail?.kind === 'diff' && detail.commit ? { kind: 'files', commit: detail.commit } : null;
}

export function useRemoteGit({ client, cwd, active, connected, refreshInterval }: {
  client: GitClient; cwd: string; active: boolean; connected: boolean; refreshInterval?: number;
}) {
  const scope = useMemo(() => ({}), [client, cwd]);
  const current = useRef(scope);
  current.current = scope;
  const [repository, setRepository] = useState<GitRepository | null>(null);
  const [strategy, setStrategy] = useState<GitStrategy>('merge');
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const fileList = useGitFileList(changes?.files ?? []);
  const [{ commits, hasMore }, setHistory] = useState<GitHistory>({ commits: [], hasMore: false });
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [detail, setDetail] = useState<GitDetail | null>(null);
  const load = useCallback(async () => {
    const { changes: next, history, repository } = await readGitSnapshot(client, cwd);
    if (current.current !== scope) return;
    setChanges(next); setHistory(previous => refreshGitHistory(previous, history));
    setRepository(repository);
    setSelected(previous => Object.fromEntries(next.files.filter(file =>
      !file.conflict && previous[file.path] === file.version).map(file => [file.path, file.version])));
  }, [client, cwd, scope]);
  const { busy, error, notice, setNotice, run, refresh } = useGitRequests({
    scope, enabled: active && connected && !!cwd, load, refreshInterval,
  });
  useEffect(() => {
    current.current = scope;
    setChanges(null); setHistory({ commits: [], hasMore: false }); setSelected({}); setMessage(''); setDetail(null);
    setRepository(null);
    return () => { current.current = {}; };
  }, [scope]);
  const selectFiles = (files: GitChange[]) => {
    if (busy) return;
    setSelected(previous => toggleFiles(previous, files));
  };
  const toggle = (file: GitChange) => selectFiles([file]);
  const selectAll = () => selectFiles(changes?.files ?? []);
  const commit = () => run(async () => {
    if (!changes || changes.files.some(file => file.conflict)
      || !message.trim() || !Object.keys(selected).length) return;
    const result = await client.commit({ cwd, head: changes.head, message: message.trim(),
      files: Object.entries(selected).map(([path, version]) => ({ path, version })) });
    if (current.current !== scope) return;
    setSelected({}); setMessage(''); setDetail(null); setNotice(`已提交 ${result.hash.slice(0, 8)}`);
    await load();
  });
  const action = (action: GitAction, target?: string) => run(async () => {
    if (!changes) return;
    let failure: unknown;
    try {
      await client.action({ cwd, action, target, strategy: action === 'update' ? 'merge' : strategy,
        head: changes.head, branch: changes.branch });
      if (current.current !== scope) return;
      setDetail(null); setNotice(GIT_ACTION_NOTICE[action]);
    } catch (error) { failure = error; }
    // Failed integration may leave conflicts that must be visible immediately.
    try { await load(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  });
  const more = () => run(async () => {
    const page = await client.history(cwd, commits.length);
    if (current.current !== scope) return;
    setHistory(previous => ({ commits: [...previous.commits,
      ...page.commits.filter(commit => !previous.commits.some(row => row.hash === commit.hash))],
    hasMore: page.hasMore }));
  });
  return { busy, error, notice, changes, commits, hasMore, selected, message, setMessage, tab, setTab,
    detail, setDetail, backDetail: () => setDetail(parentGitDetail), refresh, toggle, selectAll, selectFiles, commit, more,
    repository, action, strategy, setStrategy, fileList,
    canCommit: connected && !busy && !!message.trim() && Object.keys(selected).length > 0
      && !changes?.files.some(file => file.conflict) };
}

export type RemoteGit = ReturnType<typeof useRemoteGit>;

export function useGitDiff(client: GitClient, cwd: string, detail: GitDetail | null,
  options: boolean | { enabled: boolean; version?: string }) {
  const { enabled, version } = typeof options === 'boolean' ? { enabled: options, version: undefined } : options;
  const path = detail?.kind === 'diff' ? detail.path : undefined;
  const commit = detail?.commit?.hash;
  const [value, setValue] = useState<GitDiff | null>(null);
  const [error, setError] = useState('');
  const requests = useMemo(() => new Map<string, Promise<GitDiff>>(), [client]);
  useEffect(() => { setValue(null); setError(''); }, [client, cwd, path, commit]);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      if (!path || !enabled) return;
      const key = JSON.stringify([cwd, path, commit]);
      // Coalesce rapid file changes while a slower diff is still in flight.
      await requests.get(key)?.catch(() => undefined);
      if (!alive) return;
      const request = client.diff(cwd, path, commit);
      requests.set(key, request);
      try {
        const next = await request;
        if (alive) { setValue(next); setError(''); }
      } catch (error) { if (alive) setError(gitErrorText(error)); }
      finally { if (requests.get(key) === request) requests.delete(key); }
    };
    void read();
    return () => { alive = false; };
  }, [client, cwd, path, commit, enabled, version, requests]);
  return { value, error };
}
