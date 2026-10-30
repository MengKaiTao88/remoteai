import { filePreviewKind, type FilePreviewKind } from '../file-preview/kinds';
import { isDownloadOnlyFile } from '../remote-chat/filePreview';
import type { LoungeAttachment } from './attachments';
import { decodeChatUtf8 } from '../remote-chat/utf8';

export type LoungePreviewKind = FilePreviewKind | 'text';
export function loungePreviewKind(file: Pick<LoungeAttachment, 'name' | 'mime'>,
  bytes?: Uint8Array): LoungePreviewKind | undefined {
  if (isDownloadOnlyFile(file.name, { mediaPreview: true })) return undefined;
  // TypeScript and MPEG transport streams share extensions; match the GUI's packet sync detection.
  if (/\.(m?ts)$/i.test(file.name) && bytes
    && (bytes[0] === 0x47 && bytes[188] === 0x47 || bytes[4] === 0x47 && bytes[196] === 0x47)) return 'video';
  return filePreviewKind(file.name) ?? 'text';
}
export function attachmentExtension(name: string) {
  const extension = name.includes('.') ? name.split('.').at(-1)! : '';
  return extension.length <= 8 ? extension.toUpperCase() : '';
}
export function attachmentSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}
/** Match GUI text decoding: accept UTF BOMs and reject binary content instead of displaying corrupt glyphs. */
export function decodeAttachmentText(bytes: Uint8Array) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const text = typeof TextDecoder !== 'undefined' ? new TextDecoder(encoding, { fatal: true }).decode(bytes)
    : encoding === 'utf-8' ? decodeChatUtf8(bytes).replace(/^\uFEFF/, '') : decodeUtf16(bytes, encoding === 'utf-16le');
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) throw new Error('client.filePreview.unavailable');
  return text;
}
function decodeUtf16(bytes: Uint8Array, little: boolean) {
  if (bytes.length % 2) throw new Error('client.filePreview.unavailable');
  const units: number[] = [];
  for (let index = 2; index < bytes.length; index += 2) {
    units.push(little ? bytes[index] | bytes[index + 1] << 8 : bytes[index] << 8 | bytes[index + 1]);
  }
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    if (unit < 0xd800 || unit > 0xdfff) continue;
    const next = units[++index];
    if (unit > 0xdbff || next === undefined || next < 0xdc00 || next > 0xdfff) {
      throw new Error('client.filePreview.unavailable');
    }
  }
  const chunks: string[] = [];
  for (let index = 0; index < units.length; index += 8192) chunks.push(String.fromCharCode(...units.slice(index, index + 8192)));
  return chunks.join('');
}
