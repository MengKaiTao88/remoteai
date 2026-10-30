import { createRoot } from 'react-dom/client';
import PdfPreview from '../file-preview/PdfPreview';
import { JsonPreview } from '../file-preview/JsonPreview';
import { setInterfaceLanguage } from '../localization/interfaceLanguage';
import type { Language } from '../localization/language';
import { decodeAttachmentText } from './filePresentation';
import { themeColor } from '../theme/mode';

interface DocumentInput { name: string; mime: string; language: Language; dark: boolean; base64: string }
declare global { interface Window {
  loungeDocument: (input: DocumentInput) => void;
  ReactNativeWebView?: { postMessage: (message: string) => void };
} }
const root = createRoot(document.getElementById('root')!);
window.loungeDocument = input => {
  setInterfaceLanguage(input.language);
  document.documentElement.dataset.theme = input.dark ? 'dark' : 'light';
  const color = themeColor(input.dark ? 'dark' : 'light');
  const tokens = { '--green-soft': color('#e6f5f0', 'accentSoft'),
    '--app-accent': color('#217745', 'accent'), '--app-warning': color('#a45817', 'warning'),
    '--app-purple': color('#8950ab', 'purple') };
  for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
  const bytes = Uint8Array.from(atob(input.base64), value => value.charCodeAt(0));
  root.render(input.name.toLowerCase().endsWith('.pdf')
    ? <PdfPreview file={new Blob([bytes], { type: input.mime })} name={input.name} />
    : <JsonPreview text={decodeAttachmentText(bytes)} size={bytes.length} />);
};
window.ReactNativeWebView?.postMessage('ready');
