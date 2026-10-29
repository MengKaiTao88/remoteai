import { useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { displayText as t } from '../localization/messages';
import { browserFileSource } from './browserAttachments';
import { checkAttachmentSize } from './attachments';
import { useLoungeAttachmentLimit } from './useLoungeAttachmentLimit';
import type { LoungeDraft } from './types';
import { sendError } from './contacts';
import './attachments.css';

export function LoungeFileButton({ send, disabled, close }: {
  send: (draft: LoungeDraft) => Promise<void>; disabled: boolean; close?: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const fileLimit = useLoungeAttachmentLimit('file', true);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const choose = async (file?: File) => {
    if (!file || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      checkAttachmentSize(file, 'file', 'private');
      await send({ text: '', images: [], files: [browserFileSource(file)] }); close?.();
    } catch (failure) { setError(sendError(failure)); }
    finally { locked.current = false; setBusy(false); }
  };
  return <span className="lounge-file-control">
    <button type="button" disabled={disabled || busy} aria-label={t('client.lounge.sendFile')}
      title={t('client.lounge.fileLimitHint', { size: fileLimit / 1024 / 1024 })}
      onClick={() => picker.current?.click()}><Paperclip size={22} />
      {close && t('client.lounge.sendFile')}</button>
    <input ref={picker} type="file" hidden onChange={event => {
      void choose(event.target.files?.[0]); event.target.value = '';
    }} />
    {error && <span role="alert" className="lounge-file-error">{t(error)}</span>}
  </span>;
}
