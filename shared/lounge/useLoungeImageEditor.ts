import { useEffect, useState, type SetStateAction } from 'react';
import { base64Bytes } from '../remote-chat/policy';
import { imageData, MAX_IMAGE_BYTES } from './types';

// Lounge attachments have their own wire limit, regardless of the active AI chat connection.
export const LOUNGE_IMAGE_EDITOR_LIMITS = { targetBytes: MAX_IMAGE_BYTES, maxEdge: 2048 };
export interface LoungeImageAttachmentsProps {
  images: string[]; setImages: (value: SetStateAction<string[]>) => void; disabled: boolean;
  onEditingChange: (editing: boolean) => void;
}

export function useLoungeImageEditor({ images, setImages, disabled, onEditingChange }: LoungeImageAttachmentsProps) {
  const [selection, setSelection] = useState<{ index: number; original: string }>();
  const editing = !disabled && selection && images[selection.index] === selection.original ? selection : undefined;
  useEffect(() => { if (!editing) setSelection(undefined); }, [editing]);
  useEffect(() => {
    onEditingChange(!!editing);
    return () => onEditingChange(false);
  }, [!!editing, onEditingChange]);
  const open = (index: number) => {
    if (!disabled && images[index]) setSelection({ index, original: images[index] });
  };
  const save = (dataUrl: string) => {
    if (!editing) return;
    if (!imageData(dataUrl) || base64Bytes(dataUrl) > MAX_IMAGE_BYTES) throw new Error('client.lounge.imageFailed');
    setImages(current => current.map((image, index) =>
      index === editing.index && image === editing.original ? dataUrl : image));
  };
  return { editing, open, save, close: () => setSelection(undefined) };
}
