import { AttachmentConnection } from './attachmentConnection';
import { authorize } from './authorize';
import { ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENTS, checkAttachmentSize, parseAttachments, type AttachmentSource,
  type AttachmentSink, type LoungeAttachment } from './attachments';
import { base64Bytes } from '../remote-chat/policy';
import type { LoungeDraft, LoungeSession } from './types';

export function imageAttachmentSource(data: string): AttachmentSource {
  const comma = data.indexOf(',');
  const mime = data.slice(5, data.indexOf(';'));
  return { name: `image.${mime.split('/')[1]}`, mime, size: base64Bytes(data),
    // Chunk boundaries are multiples of three bytes, so base64 slices stay independently decodable.
    read: async (offset, length) => data.slice(comma + 1 + offset / 3 * 4,
      comma + 1 + Math.ceil((offset + length) / 3) * 4) };
}

export class LoungeAttachmentManager {
  private readonly images = new Map<string, Promise<string>>();
  private readonly sources = new Map<string, AttachmentSource>();
  private readonly connection?: AttachmentConnection;
  private available = false;
  constructor(private readonly options: { session?: LoungeSession; randomId: () => string }) {
    const { session, randomId } = options;
    this.device = randomId();
    if (session?.sync) this.connection = new AttachmentConnection({ baseUrl: session.baseUrl,
      deviceId: this.device, transport: session.sync, authorize: () => authorize(session),
      source: id => this.sources.get(id) });
  }
  readonly device: string;
  /** The app binds its persistent download manager for the lifetime of the signed-in lounge. */
  enqueue?: (file: LoungeAttachment) => Promise<string>;
  async openReader(file: LoungeAttachment, signal?: AbortSignal) {
    const source = file.device === this.device ? this.sources.get(file.id) : undefined;
    if (signal?.aborted) throw new Error('client.lounge.fileUnavailable');
    if (source) return { read: source.read, close: () => {} };
    const connection = this.connection;
    if (!connection) throw new Error('client.lounge.fileUnavailable');
    const peer = await connection.open(file, signal);
    const close = () => { signal?.removeEventListener('abort', close); connection.release(peer); };
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) { close(); throw new Error('client.lounge.fileUnavailable'); }
    return { read: (offset: number, length: number) => peer.exchange.read(offset, length), close };
  }
  image(file: LoungeAttachment): Promise<string> {
    const previous = this.images.get(file.id);
    if (previous) return previous;
    const store = this.options.session?.attachmentImages;
    if (!store) return Promise.reject(new Error('client.lounge.fileUnavailable'));
    const pending = (async () => {
      const cached = await store.get(file.id);
      if (cached) return cached;
      const uri = await this.download(file, await store.sink(file));
      await store.put(file.id, uri);
      return uri;
    })().catch(error => { this.images.delete(file.id); throw error; });
    this.images.set(file.id, pending);
    return pending;
  }
  prefetch(files?: LoungeAttachment[]) {
    for (const file of files ?? []) if (file.kind === 'image') {
      // The image card exposes retry when a sender goes offline or local storage is unavailable.
      void this.image(file).catch(() => {});
    }
  }
  ready(available: boolean) {
    this.available = available && !!this.connection;
    if (this.available) this.connection?.start();
    else this.connection?.stop();
  }
  prepare(draft: LoungeDraft): LoungeDraft {
    const { files = [], ...rest } = draft;
    if (!files.length && !draft.images.length) return rest;
    if (!this.available) {
      if (files.length) throw new Error('client.lounge.fileUnavailable');
      return rest;
    }
    const images = draft.images.map(imageAttachmentSource);
    if (images.length + files.length + (rest.attachments?.length ?? 0) > MAX_ATTACHMENTS) {
      throw new Error('client.lounge.attachmentLimit');
    }
    const attachments = [...(rest.attachments ?? [])];
    for (const [source, kind] of [...images.map(source => [source, 'image'] as const),
      ...files.map(source => [source, 'file'] as const)]) {
      checkAttachmentSize(source, kind, draft.to);
      const id = this.options.randomId();
      const file: LoungeAttachment = { id, device: this.device, name: source.name,
        mime: source.mime, size: source.size, kind };
      if (!parseAttachments([file])) throw new Error('client.lounge.fileUnavailable');
      attachments.push(file); this.sources.set(id, source);
    }
    return { ...rest, attachments, images: [] };
  }
  async download(file: LoungeAttachment, sink: AttachmentSink, options: {
    signal?: AbortSignal; progress?: (fraction: number) => void;
  } = {}) {
    const source = file.device === this.device ? this.sources.get(file.id) : undefined;
    if (source) {
      try {
        if (options.signal?.aborted) throw new Error('client.lounge.fileUnavailable');
        for (let offset = 0; offset < source.size; offset += ATTACHMENT_CHUNK_BYTES) {
          if (options.signal?.aborted) throw new Error('client.lounge.fileUnavailable');
          const size = Math.min(ATTACHMENT_CHUNK_BYTES, source.size - offset);
          await sink.write(await source.read(offset, size)); options.progress?.((offset + size) / source.size);
        }
        if (options.signal?.aborted) throw new Error('client.lounge.fileUnavailable');
        return await sink.finish();
      } catch (error) { await sink.abort(); throw error; }
    }
    if (!this.connection) { await sink.abort(); throw new Error('client.lounge.fileUnavailable'); }
    const peer = await this.connection.open(file, options.signal).catch(async error => { await sink.abort(); throw error; });
    try { return await peer.exchange.download(file, sink, options); }
    finally { this.connection.release(peer); }
  }
  stop() { this.connection?.stop(); this.available = false; this.sources.clear(); this.images.clear(); }
}
