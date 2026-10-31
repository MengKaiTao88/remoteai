import { displayText } from '../i18n/index';
import { ViewportContent } from '../../../../shared/chat/ViewportContent';
import { t, useLanguage } from '../i18n';
import { createContext, useContext, useState } from 'react';
import { useChatImage, type ImagePreviewOptions } from '../../../../shared/remote-chat/client/useChatImage';
import { ImageViewer } from '../../../../shared/chat/ImageViewer';
import { downloadChatImage } from './downloadImage';
import { FileEnvironmentContext } from '../../../desktop/src/pages/codexGui/fileEnvironment';
import { ImagePreview } from '../../../desktop/src/pages/codexGui/ImagePreview';
import { remoteImageBytes } from './remoteImageBytes';
import { useDesktopLayout } from '../useDesktopLayout';
import thumbnailStyles from '../../../../shared/chat/toolImageThumbnail.module.css';

export const ChatImageContext = createContext<ImagePreviewOptions | null>(null);

type ChatImageProps = { source?: string; description?: string; compact?: boolean };

export function ChatImage(props: ChatImageProps) {
  return <ViewportContent key={props.source} image>{() => <VisibleChatImage {...props} />}</ViewportContent>;
}

function VisibleChatImage({ source, description = t("client.chat.image"), compact }: {
  source?: string; description?: string; compact?: boolean;
}) {
  useLanguage();
  const desktop = useDesktopLayout();
  const environment = useContext(FileEnvironmentContext);
  const image = useChatImage(source, useContext(ChatImageContext));
  const [preview, setPreview] = useState(false);
  if (image.failed) return <span className="chat-image-notice" role="status">
    {description}{t("client.chat.couldNotLoadImage")} <button type="button" className="chat-button" onClick={image.retry}>{t("client.terminal.retry")}</button>
  </span>;
  if (image.loading || !image.url) return <span className="chat-image-notice" role="status">{t("client.chat.loadingImage")}</span>;
  return <>
    <button type="button" className={`chat-image${compact ? ` ${thumbnailStyles.thumbnail}` : ''}`}
      aria-label={t("client.chat.enlarge", { value1: description })} onClick={() => setPreview(true)}>
      <img key={image.key} src={image.url} alt={description} loading="lazy" decoding="async"
        referrerPolicy="no-referrer" onError={image.fail} />
    </button>
    {preview && (environment ? <ImagePreview key={image.key} thumbnail={image.url} description={description}
      load={image.original} prepare={remoteImageBytes} download={image.save ?? downloadChatImage}
      close={() => setPreview(false)} /> : <ImageViewer key={image.key} thumbnail={image.url} description={description}
      inlineViewControls={desktop}
      translate={displayText} load={image.original} download={image.save ?? downloadChatImage} close={() => setPreview(false)} />)}
  </>;
}
