import { useEffect, useMemo, useRef, useState } from 'react';
import { Asset } from 'expo-asset';
import { readAsStringAsync } from 'expo-file-system';
import { Text } from 'react-native';
import { WebView } from 'react-native-webview';
import { fromByteArray } from 'base64-js';
import type { LoungeAttachment } from '../../../../shared/lounge/attachments';
import { useThemeColor, useThemeMode } from '../theme/store';
import { textMetrics } from '../theme/text';
import { t, useLanguage } from '../i18n';

export function LoungeDocumentPreview({ file, bytes }: { file: LoungeAttachment; bytes: Uint8Array }) {
  const language = useLanguage();
  const theme = useThemeMode();
  const color = useThemeColor();
  const view = useRef<WebView>(null);
  const [html, setHtml] = useState('');
  const source = useMemo(() => ({ html }), [html]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let closed = false;
    const load = async () => {
      const asset = Asset.fromModule(require('../../assets/lounge-document.html'));
      await asset.downloadAsync();
      if (!asset.localUri) throw new Error('Missing preview');
      const content = await readAsStringAsync(asset.localUri);
      if (!closed) setHtml(content);
    };
    void load().catch(() => { if (!closed) setFailed(true); });
    return () => { closed = true; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const input = { name: file.name, mime: file.mime, language, dark: theme === 'dark', base64: fromByteArray(bytes) };
    view.current?.injectJavaScript(`window.loungeDocument(${JSON.stringify(input)}); true;`);
  }, [ready, file, bytes, language, theme]);
  if (failed || !html) return <Text style={{ ...textMetrics(14, 22), margin: 20, maxWidth: 400,
    color: color('#708078', 'muted') }}>
    {t(failed ? 'client.filePreview.unavailable' : 'client.projectBrowser.loading')}</Text>;
  return <WebView ref={view} source={source} style={{ flex: 1 }} originWhitelist={['*']}
    onMessage={({ nativeEvent }) => { if (nativeEvent.data === 'ready') setReady(true); }}
    onError={() => setFailed(true)} onShouldStartLoadWithRequest={({ url }) => url === 'about:blank'}
    javaScriptEnabled allowFileAccess={false} allowFileAccessFromFileURLs={false}
    allowUniversalAccessFromFileURLs={false} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
    setSupportMultipleWindows={false} javaScriptCanOpenWindowsAutomatically={false} />;
}
