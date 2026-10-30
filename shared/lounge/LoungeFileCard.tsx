import { lazy, Suspense, useState } from 'react';
import { Download, Eye } from 'lucide-react';
import type { LoungeAttachment } from './attachments';
import type { LoungeController } from './controller';
import { displayText as t } from '../localization/messages';
import { attachmentExtension, attachmentSize, loungePreviewKind } from './filePresentation';
import { LoungeFileIcon } from './LoungeFileIcon';
import { MobileLoungeSheet } from './MobileLoungeSheet';
import { useFileActions } from './useFileActions';
import './fileCard.css';

const LoungeFilePreview = lazy(() => import('./LoungeFilePreview'));
export function LoungeFileCard({ file, controller, mobile }: {
  file: LoungeAttachment; controller: LoungeController; mobile?: boolean;
}) {
  const [sheet, setSheet] = useState(false);
  const [preview, setPreview] = useState(false);
  const actions = useFileActions(file, controller);
  const previewable = !!loungePreviewKind(file);
  const details = <><LoungeFileIcon file={file} /><span className="lounge-file-details">
    <strong>{file.name}</strong><span>{attachmentSize(file.size)}
      {attachmentExtension(file.name) && <> · {attachmentExtension(file.name)}</>}</span></span></>;
  const buttons = <div className="lounge-file-actions">
    {previewable && <button type="button" onClick={() => { setSheet(false); setPreview(true); }}>
      <Eye size={17} aria-hidden="true" />{t('client.chat.preview')}</button>}
    <button type="button" disabled={actions.busy} onClick={() => void actions.download()}>
      <Download size={17} aria-hidden="true" />{t('client.projectBrowser.download')}</button>
  </div>;
  return <>
    <div className={`lounge-file-card${mobile ? ' is-mobile' : ''}`}>
      {mobile ? <button type="button" className="lounge-file-summary" onClick={() => setSheet(true)}
        aria-label={t('client.lounge.fileActions', { name: file.name })}>{details}</button>
        : <><div className="lounge-file-summary">{details}</div>{buttons}</>}
      {!mobile && actions.notice && <p role="status" className="lounge-file-notice">{t(actions.notice)}</p>}
    </div>
    {sheet && <MobileLoungeSheet title={t('client.chat.files.39932f')} close={() => setSheet(false)}
      className="lounge-file-sheet"><div className="lounge-file-summary">{details}</div>
      <p className="lounge-file-notice">{t('client.lounge.fileOnlineHint')}</p>{buttons}
      {actions.notice && <p role="status" className="lounge-file-notice">{t(actions.notice)}</p>}
    </MobileLoungeSheet>}
    {preview && <Suspense fallback={null}><LoungeFilePreview file={file} controller={controller}
      close={() => setPreview(false)} /></Suspense>}
  </>;
}
