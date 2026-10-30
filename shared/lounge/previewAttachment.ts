import { toByteArray } from 'base64-js';
import { checkPreviewSize, previewMimeType } from '../file-preview/kinds';
import type { LoungeAttachment } from './attachments';
import type { LoungeAttachmentManager } from './attachmentManager';
import { loungePreviewKind } from './filePresentation';

/** Preview bytes are bounded and ephemeral; explicit downloads belong to the persistent download manager. */
export async function previewAttachment(options: {
  file: LoungeAttachment; attachments: LoungeAttachmentManager; signal: AbortSignal;
  progress: (fraction: number) => void;
}): Promise<Uint8Array> {
  const { file, attachments, signal, progress } = options;
  checkPreviewSize(file.size);
  const bytes = new Uint8Array(file.size);
  let offset = 0;
  await attachments.download(file, {
    write: async data => {
      if (signal.aborted) throw new Error('client.lounge.fileUnavailable');
      const chunk = toByteArray(data);
      if (offset + chunk.length > bytes.length) throw new Error('client.lounge.fileUnavailable');
      bytes.set(chunk, offset); offset += chunk.length;
    },
    finish: async () => {
      if (offset !== file.size) throw new Error('client.lounge.fileUnavailable');
      return '';
    },
    abort: async () => { bytes.fill(0); },
  }, { signal, progress });
  return bytes;
}
export function attachmentMime(file: LoungeAttachment, bytes?: Uint8Array) {
  if (/\.(m?ts)$/i.test(file.name) && loungePreviewKind(file, bytes) === 'video') return 'video/mp2t';
  return file.mime && file.mime !== 'application/octet-stream' ? file.mime : previewMimeType(file.name);
}
