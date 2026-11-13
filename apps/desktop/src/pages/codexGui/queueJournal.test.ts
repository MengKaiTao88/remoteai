import { expect, it, vi } from 'vitest';
import { QueueJournal, type QueueSnapshot, type QueueStorage } from './queueJournal';
import type { QueuedMessage } from '../../../../../shared/conversation/types';

const message: QueuedMessage = { id: 'one', text: 'next task', images: [], skills: [],
  model: 'model', effort: 'high', access: 'read-only' };
function storage() {
  let disk: QueueSnapshot = { revision: 0, threads: {} };
  const store: QueueStorage = {
    read: async () => structuredClone(disk),
    save: vi.fn(async snapshot => {
      if (snapshot.revision !== disk.revision) throw new Error('conflict');
      disk = structuredClone({ ...snapshot, revision: disk.revision + 1 });
      return disk;
    }),
  };
  return store;
}

it('restores waiting messages, but never automatically redispatches an interrupted send', async () => {
  const store = storage();
  const journal = new QueueJournal(store, vi.fn(), vi.fn());
  await journal.restore();
  journal.remember({ thread: [message, { ...message, id: 'sending', busy: true }] });
  await journal.saved();
  const restore = vi.fn();
  await new QueueJournal(store, restore, vi.fn()).restore();
  expect(restore).toHaveBeenCalledWith({ thread: [message, expect.objectContaining({
    id: 'sending', busy: false, needsReview: true,
  })] });
});

it('does not acknowledge a message while its save is pending or has failed', async () => {
  const store = storage();
  let reject!: (error: Error) => void;
  store.save = vi.fn(() => new Promise<QueueSnapshot>((_resolve, failed) => { reject = failed; }));
  const failed = vi.fn(); const accepted = vi.fn();
  const journal = new QueueJournal(store, vi.fn(), failed);
  await journal.restore();
  journal.remember({ thread: [message] });
  const pending = journal.saved().then(accepted);
  const rejected = expect(pending).rejects.toThrow('disk full');
  await Promise.resolve(); expect(accepted).not.toHaveBeenCalled();
  reject(new Error('disk full')); await rejected;
  expect(failed).toHaveBeenCalledOnce();
});

it('preserves the pre-send failure classification and contents while restoring failed drafts', async () => {
  const failed = { ...message, error: '发送失败，请重试。', needsReview: false };
  const restore = vi.fn();
  const store: QueueStorage = { read: async () => ({ revision: 5, threads: { thread: [failed] } }),
    save: vi.fn() };
  await new QueueJournal(store, restore, vi.fn()).restore();
  expect(restore).toHaveBeenCalledWith({ thread: [failed] });
  expect(failed.needsReview).toBe(false);
  expect(store.save).not.toHaveBeenCalled();
});

it('serializes writes and retains the latest edit across reopening', async () => {
  const store = storage();
  const journal = new QueueJournal(store, vi.fn(), vi.fn()); await journal.restore();
  journal.remember({ thread: [message] });
  journal.remember({ thread: [{ ...message, text: 'edited' }] });
  await journal.saved();
  expect(await store.read()).toEqual({ revision: 2, threads: { thread: [{ ...message, text: 'edited' }] } });
});

it('reviews restored official failures without claiming the independent owner queue failed or replaying a draft', async () => {
  const failed = { ...message, error: '发送失败，请重试。', needsReview: false };
  const restore = vi.fn();
  const store: QueueStorage = { reviewRestoredFailures: true,
    read: async () => ({ revision: 5, threads: { thread: [failed] } }), save: vi.fn() };
  await new QueueJournal(store, restore, vi.fn()).restore();
  expect(restore).toHaveBeenCalledWith({ thread: [{ ...failed, busy: false, needsReview: true,
    error: '上次发送结果尚未确认，请查看聊天后决定是否重发。' }] });
  expect(store.save).not.toHaveBeenCalled();
  expect(failed.error).toBe('发送失败，请重试。');
});
