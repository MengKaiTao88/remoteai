import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { LoungeAccount, LoungeSnapshot } from './types';
import type { LoungeController } from './controller';
import { MAX_NICKNAME, MAX_REMARK, validName } from './names';

export interface LoungeNameEditorOptions {
  user: LoungeAccount; state: LoungeSnapshot; controller: LoungeController;
  saveRef?: Ref<LoungeNameEditorHandle>;
}

export interface LoungeNameEditorHandle { save: () => Promise<boolean> }

export function useLoungeNameEditor({ user, state, controller, saveRef }: LoungeNameEditorOptions) {
  const own = user.id === state.user?.id;
  const kind = own ? 'nickname' : 'remark';
  const stored = user[kind] ?? '';
  const limit = own ? MAX_NICKNAME : MAX_REMARK;
  const [draft, setDraft] = useState<string>();
  const draftRef = useRef<string | undefined>(undefined);
  const revision = useRef(0);
  const pending = useRef<Promise<boolean> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'' | 'client.lounge.nicknameSaveFailed' | 'client.lounge.remarkSaveFailed'>('');
  const [saved, setSaved] = useState(false);
  const value = draft ?? stored;
  const available = state.status === 'connected' && state.namesAvailable === true;
  const invalid = !validName(value, limit);
  const context = { stored, available, limit, kind, userId: user.id, own, controller } as const;
  const latest = useRef(context);
  latest.current = context;
  const change = (next: string) => {
    revision.current++; draftRef.current = next;
    setDraft(next); setError(''); setSaved(false);
  };
  const save = async (): Promise<boolean> => {
    // Blur, Enter and navigation can arrive together. Serialize them and retain edits made during a save.
    if (pending.current) return await pending.current ? save() : false;
    const submitted = draftRef.current;
    if (submitted === undefined) return true;
    const current = latest.current;
    if (submitted.trim() === current.stored) {
      draftRef.current = undefined; setDraft(undefined); return true;
    }
    if (!current.available || !validName(submitted, current.limit)) return false;
    const submittedRevision = revision.current;
    setBusy(true); setError(''); setSaved(false);
    pending.current = Promise.resolve().then(() => current.controller.setName({
      kind: current.kind, userId: current.userId, value: submitted,
    })).then(() => {
      if (revision.current === submittedRevision) {
        draftRef.current = undefined; setDraft(undefined); setSaved(true);
      }
      return true;
    }, () => {
      setError(current.own ? 'client.lounge.nicknameSaveFailed' : 'client.lounge.remarkSaveFailed');
      return false;
    }).finally(() => { pending.current = undefined; setBusy(false); });
    return pending.current;
  };
  useImperativeHandle(saveRef, () => ({ save }));
  return { own, kind, value, limit, change, save, available, busy, invalid, error, saved };
}
