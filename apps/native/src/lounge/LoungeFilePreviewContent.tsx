import { useMemo } from 'react';
import { fromByteArray } from 'base64-js';
import { Text } from 'react-native';
import { WebView } from 'react-native-webview';
import type { LoungeAttachment } from '../../../../shared/lounge/attachments';
import { attachmentMime } from '../../../../shared/lounge/previewAttachment';
import { loungePreviewKind, decodeAttachmentText } from '../../../../shared/lounge/filePresentation';
import { isJsonPath } from '../../../../shared/file-preview/jsonHighlightLimit';
import { ChatHtmlPreview } from '../chat/ChatHtmlPreview';
import { ChatMarkdownPreview } from '../chat/ChatMarkdownPreview';
import { ChatCodeBlock } from '../chat/ChatCodeBlock';
import { fileLanguage } from '../chat/ChatCodeHighlight';
import { SheetScrollView } from '../components/SheetScrollView';
import { textMetrics } from '../theme/text';
import { t } from '../i18n';
import { LoungeDocumentPreview } from './LoungeDocumentPreview';
import { useThemeColor } from '../theme/store';

export function LoungeFilePreviewContent({ file, bytes }: { file: LoungeAttachment; bytes: Uint8Array }) {
  const color = useThemeColor();
  const kind = loungePreviewKind(file, bytes);
  const text = useMemo(() => {
    if (!['text', 'markdown', 'html'].includes(kind ?? '')) return '';
    try { return decodeAttachmentText(bytes); } catch { return undefined; }
  }, [bytes, kind]);
  const media = useMemo(() => {
    if (!['image', 'video', 'audio'].includes(kind ?? '')) return undefined;
    const mime = attachmentMime(file, bytes).replace(/[^a-z\d/+.\-]/gi, '');
    const url = `data:${mime};base64,${fromByteArray(bytes)}`;
    const tag = kind === 'image' ? `<img src="${url}">` : `<${kind} src="${url}" controls playsinline></${kind}>`;
    return { html: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;;'
      + ' img-src data:; media-src data:; style-src &apos;unsafe-inline&apos;">'
      + '<style>body{margin:0;background:#171b1f;height:100vh;display:grid;place-items:center}'
      + 'img,video{max-width:100%;max-height:100vh}audio{width:90%}</style></head><body>' + tag + '</body></html>' };
  }, [bytes, file, kind]);
  if (text === undefined) return <Text style={{ ...textMetrics(14, 22), margin: 20, maxWidth: 400,
    color: color('#708078', 'muted') }}>
    {t('client.filePreview.unavailable')}</Text>;
  if (kind === 'pdf' || isJsonPath(file.name)) return <LoungeDocumentPreview file={file} bytes={bytes} />;
  if (kind === 'html') return <ChatHtmlPreview text={text} />;
  if (kind === 'markdown') return <ChatMarkdownPreview text={text} />;
  if (media) return <WebView source={media} style={{ flex: 1 }} originWhitelist={['*']}
    onShouldStartLoadWithRequest={({ url }) => url === 'about:blank'}
    javaScriptEnabled={false} allowFileAccess={false} allowFileAccessFromFileURLs={false}
    allowUniversalAccessFromFileURLs={false} mediaPlaybackRequiresUserAction allowsInlineMediaPlayback
    sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} />;
  return <SheetScrollView style={{ flex: 1 }}><ChatCodeBlock text={text} language={fileLanguage(file.name)}
    lineNumbers label={file.name} copyLabel={t('client.chat.copyFileContents')} /></SheetScrollView>;
}
