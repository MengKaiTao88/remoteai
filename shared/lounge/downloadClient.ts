import { fromByteArray, toByteArray } from 'base64-js';
import type { DownloadClient, DownloadOpen } from '../remote-chat/downloads';
import type { FileRead } from '../remote-chat/fileDownload';
import { ATTACHMENT_CHUNK_BYTES, checkAttachmentSize, parseAttachments } from './attachments';
import type { LoungeAttachmentManager } from './attachmentManager';

export const LOUNGE_DOWNLOAD_DEVICE = 'lounge-attachments';
type Reader = Awaited<ReturnType<LoungeAttachmentManager['openReader']>>;
interface Handle { reader: Reader; transferId: string; size: number; pending: Promise<unknown> }

/** Adapt authenticated attachment reads to the existing persistent, resumable download engines. */
export function loungeDownloadClient(attachments: LoungeAttachmentManager): DownloadClient {
  const handles = new Map<string, Handle>();
  const open = async (request: DownloadOpen, controls?: { signal?: AbortSignal }) => {
    const file = parseAttachments([request.attachment])?.[0];
    if (!file || file.name !== request.path) throw new Error('client.lounge.fileUnavailable');
    checkAttachmentSize(file, 'file', 'lounge');
    const reader = await attachments.openReader(file, controls?.signal);
    const id = `${file.id.slice(0, 24)}${request.transferId.slice(-12)}`;
    handles.get(id)?.reader.close();
    handles.set(id, { reader, transferId: request.transferId, size: file.size, pending: Promise.resolve() });
    return { id, size: file.size, name: file.name, mimeType: file.mime, revision: `${file.device}:${file.id}` };
  };
  const read = async (request: FileRead) => {
    const handle = handles.get(request.id);
    if (!handle || handle.transferId !== request.threadId || !Number.isSafeInteger(request.offset)
      || !Number.isSafeInteger(request.length) || request.offset < 0 || request.length < 1
      || request.length > 256 * 1024 || request.offset + request.length > handle.size) {
      throw new Error('client.lounge.fileUnavailable');
    }
    // Download engines pipeline reads; the attachment protocol acknowledges one bounded chunk at a time.
    const result = handle.pending.then(async () => {
      if (handles.get(request.id) !== handle) throw new Error('client.lounge.fileUnavailable');
      const bytes = new Uint8Array(request.length);
      for (let offset = 0; offset < request.length; offset += ATTACHMENT_CHUNK_BYTES) {
        const length = Math.min(ATTACHMENT_CHUNK_BYTES, request.length - offset);
        const chunk = toByteArray(await handle.reader.read(request.offset + offset, length));
        if (chunk.length !== length) throw new Error('client.lounge.fileUnavailable');
        bytes.set(chunk, offset);
      }
      return { offset: request.offset, data: fromByteArray(bytes) };
    });
    handle.pending = result.catch(() => {}); // Keep the serialization queue usable after an individual read fails.
    return result;
  };
  return { open, read, checkSize: size => checkAttachmentSize({ size }, 'file', 'lounge'),
    browse: async () => { throw new Error('client.lounge.fileUnavailable'); },
    close: async (transferId, id) => {
      const handle = handles.get(id);
      if (handle?.transferId === transferId) { handles.delete(id); handle.reader.close(); }
    } };
}
