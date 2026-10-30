import { useEffect, useState } from 'react';
import { Modal } from 'antd';
import { Download, Maximize, Minimize, RotateCw } from 'lucide-react';
import { displayText as t } from '../localization/messages';
import type { LoungeAttachment } from './attachments';
import type { LoungeController } from './controller';
import { previewAttachment } from './previewAttachment';
import { LoungeFilePreviewContent } from './LoungeFilePreviewContent';
import { useFileActions } from './useFileActions';
import './filePreview.css';

export default function LoungeFilePreview({ file, controller, close }: {
  file: LoungeAttachment; controller: LoungeController; close: () => void;
}) {
  const [bytes, setBytes] = useState<Uint8Array>();
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const actions = useFileActions(file, controller);
  useEffect(() => {
    const abort = new AbortController();
    setBytes(undefined); setError(''); setProgress(0);
    void previewAttachment({ file, attachments: controller.attachments, signal: abort.signal,
      progress: value => { if (!abort.signal.aborted) setProgress(value); },
    }).then(value => { if (!abort.signal.aborted) setBytes(value); }).catch(cause => {
      if (!abort.signal.aborted) setError(cause instanceof Error && cause.message === 'client.filePreview.tooLarge'
        ? cause.message : 'client.lounge.fileUnavailable');
    });
    return () => abort.abort();
  }, [file, controller, attempt]);
  return <Modal open onCancel={close} footer={null} width={fullscreen ? '100vw' : 1000}
    className={`lounge-file-preview${fullscreen ? ' is-fullscreen' : ''}`} centered={!fullscreen}
    title={<span className="lounge-file-preview-title">{file.name}</span>}>
    <div className="lounge-file-preview-tools">
      <button type="button" disabled={actions.busy} onClick={() => void actions.download()}>
        <Download size={16} />{t('client.projectBrowser.download')}</button>
      <button type="button" onClick={() => setFullscreen(value => !value)}>
        {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        {t(fullscreen ? 'client.projectBrowser.exitFullscreen' : 'client.projectBrowser.enterFullscreen')}</button>
    </div>
    {actions.notice && <p role="status" className="lounge-file-preview-note">{t(actions.notice)}</p>}
    <div className="lounge-file-preview-content">
      {bytes ? <LoungeFilePreviewContent file={file} bytes={bytes} /> : error
        ? <div role="status" className="lounge-file-preview-note"><p>{t(error)}</p>
          <button type="button" onClick={() => setAttempt(value => value + 1)}>
            <RotateCw size={16} />{t('client.mobile.retryPreview')}</button></div>
        : <div role="status" className="lounge-file-preview-note">
          <p>{t('client.lounge.fileProgress', { percent: Math.round(progress * 100) })}</p>
          <progress max={1} value={progress} aria-label={t('client.lounge.receivingFile')} /></div>}
    </div>
  </Modal>;
}
