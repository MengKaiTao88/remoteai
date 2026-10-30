import { useEffect, useRef, useState } from 'react';
import { Download, File } from 'lucide-react';
import type { LoungeAttachment as Attachment } from './attachments';
import type { LoungeController } from './controller';
import { browserAttachmentSink, saveAttachmentUrl } from './browserAttachments';
import { displayText as t } from '../localization/messages';
import './attachments.css';
import { LoungeFileCard } from './LoungeFileCard';

export function LoungeAttachment(props: {
  file: Attachment; controller: LoungeController; preview: (uri: string) => void; onLoad?: () => void;
  mobile?: boolean;
}) {
  return props.file.kind === 'file' ? <LoungeFileCard {...props} /> : <ImageAttachment {...props} />;
}
function ImageAttachment({ file, controller, preview, onLoad }: {
  file: Attachment; controller: LoungeController; preview: (uri: string) => void; onLoad?: () => void;
}) {
  const [uri, setUri] = useState(''), [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0), [failed, setFailed] = useState(false);
  const active = useRef<AbortController>();
  const download = async () => {
    if (active.current) return;
    const abort = new AbortController(); active.current = abort;
    setBusy(true); setFailed(false); setProgress(0);
    try {
      const value = file.kind === 'image' ? await controller.attachments.image(file)
        : await controller.attachments.download(file, await browserAttachmentSink(file),
          { signal: abort.signal, progress: setProgress });
      if (abort.signal.aborted) return;
      if (file.kind === 'image') setUri(value); else saveAttachmentUrl(value, file.name);
    } catch { if (!abort.signal.aborted) setFailed(true); }
    finally { if (active.current === abort) active.current = undefined; if (!abort.signal.aborted) setBusy(false); }
  };
  useEffect(() => {
    if (file.kind === 'image') void download();
    return () => { active.current?.abort(); active.current = undefined; };
  }, [file.id, controller]);
  if (uri) return <button type="button" className="lounge-image" aria-label={t('client.lounge.previewImage')}
    onClick={() => preview(uri)}><img src={uri} alt={t('client.lounge.image')} onLoad={onLoad} /></button>;
  return <div className="lounge-image-transfer">
    <button type="button" disabled={busy} onClick={() => void download()}>
      <File size={24} /><span><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(2)} MB</small></span>
      <Download size={18} aria-label={t('client.lounge.downloadFile')} />
    </button>
    {busy ? <><progress max={1} value={progress} aria-label={t('client.lounge.receivingFile')} />
      <small>{t('client.lounge.fileProgress', { percent: Math.round(progress * 100) })}</small></>
      : <small role={failed ? 'alert' : undefined}>{t(failed ? 'client.lounge.fileUnavailable'
        : 'client.lounge.fileOnlineHint')}</small>}
    {busy && <button type="button" onClick={() => { active.current?.abort(); setBusy(false); }}>
      {t('client.lounge.cancel')}</button>}
  </div>;
}
