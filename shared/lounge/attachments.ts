import { getChatPolicy, MIB } from '../remote-chat/policy';

export const ATTACHMENT_CHUNK_BYTES = 192 * 1024;
export const MAX_ATTACHMENTS = 3;
export interface LoungeAttachment {
  id: string; device: string; name: string; size: number; mime: string; kind: 'file' | 'image'; grant?: string;
}
export interface AttachmentSource {
  name: string; size: number; mime: string;
  read: (offset: number, length: number) => Promise<string>;
}
export interface AttachmentSink {
  write: (base64: string) => Promise<void>;
  finish: () => Promise<string>;
  abort: () => Promise<void>;
}
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
export function parseAttachments(value: unknown): LoungeAttachment[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return;
  const files: LoungeAttachment[] = [];
  for (const item of value as Partial<LoungeAttachment>[]) {
    if (!item || typeof item.id !== 'string' || !UUID.test(item.id)
      || typeof item.device !== 'string' || !UUID.test(item.device)
      || typeof item.name !== 'string' || !item.name || [...item.name].length > 255
      || ['.', '..'].includes(item.name) || /[/\\\x00-\x1f\x7f]/.test(item.name)
      || !Number.isSafeInteger(item.size) || item.size! < 0
      || typeof item.mime !== 'string' || item.mime.length > 100
      || !['file', 'image'].includes(item.kind!)
      || item.kind === 'image' && (!['image/png', 'image/jpeg', 'image/gif'].includes(item.mime) || !item.size)
      || item.grant !== undefined && (typeof item.grant !== 'string' || item.grant.length > 8192)) return;
    files.push({ id: item.id, device: item.device, name: item.name, size: item.size!, mime: item.mime,
      kind: item.kind!, grant: item.grant });
  }
  return files;
}

export function attachmentByteLimit(kind: LoungeAttachment['kind'], direct: boolean) {
  const policy = getChatPolicy('relay');
  const mb = kind === 'file' ? policy.loungeFileMaxMb
    : direct ? policy.loungeDirectImageMaxMb : policy.loungeGroupImageMaxMb;
  return Math.min(Number.MAX_SAFE_INTEGER, mb * MIB);
}

export function checkAttachmentSize(source: Pick<AttachmentSource, 'size'>, kind: LoungeAttachment['kind'], to?: string) {
  if (!Number.isSafeInteger(source.size) || source.size < 0 || kind === 'file' && !to
    || source.size > attachmentByteLimit(kind, !!to)) throw new Error('client.lounge.attachmentLimit');
}
