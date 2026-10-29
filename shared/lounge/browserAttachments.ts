import { fromByteArray, toByteArray } from 'base64-js';
import type { AttachmentSink, AttachmentSource, LoungeAttachment } from './attachments';

export function browserFileSource(file: File): AttachmentSource {
  return { name: file.name, mime: file.type || 'application/octet-stream', size: file.size,
    read: async (offset, length) => fromByteArray(new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())) };
}

export async function browserAttachmentSink(file: LoungeAttachment): Promise<AttachmentSink> {
  const chunks: Blob[] = [];
  const directory = file.kind === 'file' && navigator.storage?.getDirectory
    ? await navigator.storage.getDirectory() : undefined;
  const path = `lounge-${crypto.randomUUID()}`;
  const handle = await directory?.getFileHandle(path, { create: true });
  const stream = await handle?.createWritable();
  const clean = async () => { if (directory) await directory.removeEntry(path); chunks.length = 0; };
  let closed = false;
  return {
    write: async data => {
      const bytes = new Uint8Array(toByteArray(data));
      if (stream) await stream.write(bytes); else chunks.push(new Blob([bytes]));
    },
    finish: async () => {
      await stream?.close(); closed = true;
      const blob = handle ? await handle.getFile() : new Blob(chunks, { type: file.mime });
      const url = file.kind === 'image' ? await blobData(blob) : URL.createObjectURL(blob);
      // Give the browser time to consume the disk-backed File snapshot before cleanup.
      if (directory) setTimeout(() => { void clean().catch(() => console.warn('Could not clean attachment')); }, 60_000);
      return url;
    },
    abort: async () => { try { if (!closed) await stream?.abort(); } finally { await clean(); } },
  };
}

function blobData(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('client.lounge.fileUnavailable')); reader.readAsDataURL(blob);
  });
}

export function saveAttachmentUrl(url: string, name: string) {
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
