import { useRef, useState } from 'react';
import { copyText } from '../clipboard';
import type { EntryRequest } from '../project-browser/entryActions';
import type { TreePrompt } from '../project-browser/useTreeActions';
import type { ExplorerState } from './useExplorer';
import { pathParts, samePath, textKey, type ExplorerEntry, type ExplorerProps } from './model';

export type Command = 'createFolder' | 'createFile' | 'cut' | 'copy' | 'paste' | 'rename' | 'delete'
  | 'copyPath' | 'share';
export function useExplorerActions(props: ExplorerProps, state: ExplorerState) {
  const [clipboard, setClipboard] = useState<{ entry: ExplorerEntry; cut: boolean }>();
  const [prompt, setPrompt] = useState<TreePrompt>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const flight = useRef(false);
  const root = state.directory ? pathParts(state.directory)[0].path : '';
  const target = state.selection;
  const writable = !!props.mutate && !!state.result && !!state.directory && !state.loading && !busy;
  const mutableSelection = writable && !!target && !samePath(target.path, root);
  const canPaste = writable && !!clipboard && samePath(pathParts(clipboard.entry.path)[0].path, root);
  const run = async (action: () => Promise<void>) => {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); }
    catch { setError(props.t(textKey('actionError'))); }
    finally { flight.current = false; setBusy(false); }
  };
  const mutate = async (request: EntryRequest) => {
    if (!props.mutate) return;
    await props.mutate(request); setPrompt(undefined); state.refresh();
  };
  const command = (action: Command) => {
    if (busy || state.loading) return;
    setError(''); setMessage('');
    if (action === 'copyPath' || action === 'share') {
      void run(async () => {
        if (action === 'share' && navigator.share) {
          try { await navigator.share({ text: target?.path ?? state.directory }); }
          catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) throw cause; }
          return;
        }
        await copyText(target?.path ?? state.directory);
        setMessage(props.t(textKey('pathCopied')));
      }); return;
    }
    if (action === 'paste') {
      if (canPaste && clipboard) void run(async () => {
        await mutate({ cwd: root, path: clipboard.entry.path,
          action: clipboard.cut ? 'move' : 'copy', directory: state.directory });
        if (clipboard.cut) setClipboard(undefined);
      });
      return;
    }
    if (action === 'createFolder' || action === 'createFile') {
      if (writable) setPrompt({ action, entry: { name: state.directory, path: state.directory, directory: true } });
      return;
    }
    if (!mutableSelection || !target) return;
    if (action === 'cut' || action === 'copy') {
      setClipboard({ entry: target, cut: action === 'cut' });
      setMessage(props.t(textKey(action === 'cut' ? 'cutReady' : 'copied'))); return;
    }
    setPrompt({ action, entry: target });
  };
  const confirm = (name: string) => run(async () => {
    if (!prompt) return;
    await mutate({ cwd: root, path: prompt.entry.path,
      ...(prompt.action === 'delete' ? { action: 'delete' } : { action: prompt.action, name }) });
    if (clipboard && samePath(clipboard.entry.path, prompt.entry.path)) setClipboard(undefined);
  });
  return { command, confirm, prompt, busy, error, message, clipboard, writable, mutableSelection, canPaste,
    cancel: () => { if (!busy) { setPrompt(undefined); setError(''); } } };
}
export type ExplorerActions = ReturnType<typeof useExplorerActions>;
