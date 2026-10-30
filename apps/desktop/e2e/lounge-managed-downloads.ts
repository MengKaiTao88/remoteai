import type { Page } from '@playwright/test';

export function managedAttachmentBytes(page: Page, attachmentId: string) {
  return page.evaluate(async attachmentId => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('codex-switch.web.downloads.v1');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const tasks = await result(database.transaction('tasks').objectStore('tasks').getAll());
      const task = tasks.find(value => value.source.attachment?.id === attachmentId && value.status === 'ready');
      if (!task) return undefined;
      const chunks: { blob: Blob; offset: number }[] = await result(database.transaction('chunks')
        .objectStore('chunks').getAll(IDBKeyRange.bound([task.id, 0], [task.id, Number.MAX_SAFE_INTEGER])));
      return Array.from(new Uint8Array(await new Blob(chunks.sort((a, b) => a.offset - b.offset)
        .map(chunk => chunk.blob)).arrayBuffer()));
    } finally { database.close(); }
  }, attachmentId);
}
