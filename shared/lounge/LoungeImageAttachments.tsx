import { X } from 'lucide-react';
import { ImageEditor } from '../chat/ImageEditor';
import { displayText as t } from '../localization/messages';
import { getInterfaceLanguage } from '../localization/interfaceLanguage';
import { LOUNGE_IMAGE_EDITOR_LIMITS, useLoungeImageEditor,
  type LoungeImageAttachmentsProps } from './useLoungeImageEditor';
import './imageAttachments.css';

export function LoungeImageAttachments(props: LoungeImageAttachmentsProps) {
  const { images, setImages, disabled } = props;
  const editor = useLoungeImageEditor(props);
  return <>
    {!!images.length && <div className="lounge-attachments">{images.map((image, index) => <div key={index}>
      <img src={image} alt={t('client.lounge.image')} />
      <button type="button" className="lounge-attachment-remove" disabled={disabled}
        aria-label={t('client.lounge.removeImage')}
        onClick={() => setImages(value => value.filter((_, position) => position !== index))}><X size={14} /></button>
      <button type="button" className="lounge-attachment-edit" disabled={disabled}
        aria-label={t('client.chat.annotateImage', { value1: index + 1 })}
        onClick={() => editor.open(index)}>{t('client.chat.annotate')}</button>
    </div>)}</div>}
    {editor.editing && <ImageEditor dataUrl={editor.editing.original} mode="direct"
      outputLimits={LOUNGE_IMAGE_EDITOR_LIMITS} language={getInterfaceLanguage()} translate={t}
      save={editor.save} close={editor.close} />}
  </>;
}
