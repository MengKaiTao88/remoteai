import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from 'antd';
import { editedImageMessage, imageEditorHtml } from './imageEditorHtml';
import { IMAGE_EDITOR_ASSET } from './imageEditorAsset';
import type { ConnectionMode } from '../remote-chat/protocol';
import { darkColors, type ThemeMode } from '../theme/mode';
import './imageEditor.css';

export function ImageEditor({ dataUrl, save, close, translate: t, language, mode, themeMode = 'light' }: {
  dataUrl: string; save: (dataUrl: string) => void; close: () => void;
  translate: (text: string) => string; language: string; mode?: ConnectionMode; themeMode?: ThemeMode;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const initialTheme = useRef(themeMode);
  const html = useMemo(() => imageEditorHtml(dataUrl, t, language, {
    scriptUrl: new URL(`${import.meta.env.BASE_URL}${IMAGE_EDITOR_ASSET}`, document.baseURI).href, mode,
    themeMode: initialTheme.current,
  }), [dataUrl, t, language, mode]);
  const [error, setError] = useState('');
  // Keep the iframe document and its unsaved annotations when the host appearance changes.
  useEffect(() => {
    const root = frame.current?.contentDocument?.documentElement;
    if (root) root.dataset.theme = themeMode;
  }, [themeMode]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || typeof event.data !== 'string') return;
      try {
        if (event.data === '{"type":"cancel"}') { close(); return; }
        const dataUrl = editedImageMessage(event.data, mode);
        if (!dataUrl) return;
        save(dataUrl);
        close();
      } catch { setError(t("图片未保存，请减少标注或图片后重试。")); }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [save, close, t, mode]);
  const loaded = () => {
    const editorDocument = frame.current?.contentDocument;
    if (editorDocument) editorDocument.documentElement.dataset.theme = themeMode;
    if (editorDocument?.documentElement.dataset.editorInitialized !== 'true') {
      editorDocument?.getElementById('cancel')?.addEventListener('click', close, { once: true });
      setError(t('图片无法编辑，请重新打开后再试。'));
    }
  };
  return <Modal open centered footer={null} title={null} closable={{ 'aria-label': t('关闭图片') }} maskClosable={false}
    onCancel={close} width={1480} className="chat-image-editor" wrapClassName="chat-image-editor-wrap" destroyOnClose
    styles={themeMode === 'dark' ? {
      content: { background: darkColors.canvas, color: darkColors.ink },
    } : undefined}
    transitionName="" maskTransitionName="">
    {/* Only our own editor and validated image data are embedded. Keeping the local origin lets
        Chromium deliver pointer gestures reliably; the document CSP only permits local images and scripts. */}
    <iframe ref={frame} title={t("图片标注")} srcDoc={html} sandbox="allow-scripts allow-same-origin" onLoad={loaded} />
    {!!error && <p role="alert" style={themeMode === 'dark' ? { color: darkColors.danger } : undefined}>{t(error)}</p>}
  </Modal>;
}
