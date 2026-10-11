import { t, useLanguage } from '../i18n';
import { useThemeMode } from '../theme/preference';
import { ImageEditor } from '../../../../shared/chat/ImageEditor';
import type { DraftImage } from '../../../../shared/remote-chat/attachments';
import './imageEditor.css';

export function ChatImageEditor({ image, save, close }: {
  image: DraftImage; save: (dataUrl: string) => void; close: () => void;
}) {
  const language = useLanguage();
  const themeMode = useThemeMode();
  return <ImageEditor dataUrl={image.url} save={save} close={close} translate={t}
    language={language} themeMode={themeMode} />;
}
