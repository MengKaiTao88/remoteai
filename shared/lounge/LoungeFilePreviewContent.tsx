import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { BrowserImagePreview } from '../file-preview/BrowserImagePreview';
import { BrowserMarkdown } from '../file-preview/BrowserMarkdown';
import { HtmlPreviewFrame } from '../file-preview/HtmlPreviewFrame';
import type { PreviewLoader } from '../file-preview/kinds';
import { PreviewContent } from '../../apps/desktop/src/pages/codexGui/filePreview/PreviewContent';
import { displayText as t } from '../localization/messages';
import type { LoungeAttachment } from './attachments';
import { decodeAttachmentText, loungePreviewKind } from './filePresentation';
import { attachmentMime } from './previewAttachment';
import '../file-preview/browserFilePreview.css';

const PdfPreview = lazy(() => import('../file-preview/PdfPreview'));
// Attachments grant access to this file only, never to another path on either participant's computer.
const unavailableAsset: PreviewLoader = async () => { throw new Error('client.filePreview.unavailable'); };

export function LoungeFilePreviewContent({ file, bytes }: { file: LoungeAttachment; bytes: Uint8Array }) {
  const [source, setSource] = useState(false);
  const [url, setUrl] = useState('');
  const [linkError, setLinkError] = useState(false);
  const kind = loungePreviewKind(file, bytes)!;
  const blob = useMemo(() => new Blob([bytes], { type: attachmentMime(file, bytes) }), [bytes, file]);
  const text = useMemo(() => {
    if (!['html', 'markdown', 'text'].includes(kind)) return null;
    try { return decodeAttachmentText(bytes); } catch { return undefined; }
  }, [bytes, kind]);
  useEffect(() => {
    const value = URL.createObjectURL(blob); setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [blob]);
  if (text === undefined) return <p role="status" className="lounge-file-preview-note">
    {t('client.filePreview.unavailable')}</p>;
  if (kind === 'pdf') return <Suspense fallback={<p>{t('client.projectBrowser.loading')}</p>}>
    <PdfPreview file={blob} name={file.name} /></Suspense>;
  if (kind === 'image') return <BrowserImagePreview src={url} name={file.name} />;
  return <>
    {(kind === 'html' || kind === 'markdown') && <div className="browser-preview-modes">
      <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>{t('client.chat.preview')}</button>
      <button type="button" aria-pressed={source} onClick={() => setSource(true)}>{t('client.downloads.source')}</button>
    </div>}
    {linkError && <p role="status" className="lounge-file-preview-note">{t('client.lounge.previewLinkedFile')}</p>}
    {kind === 'html' && !source ? <HtmlPreviewFrame text={text!} path={file.name} load={unavailableAsset} />
      : kind === 'markdown' && !source ? <BrowserMarkdown text={text!} path={file.name}
        load={unavailableAsset} openFile={() => setLinkError(true)} />
        : <PreviewContent source={source} data={{ sessionId: '', path: file.name, name: file.name,
          kind, text, url, size: file.size }} />}
  </>;
}
