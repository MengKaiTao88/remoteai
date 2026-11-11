import { expect, it, vi } from 'vitest';
import { LocalOutbox } from '../../../../shared/remote-chat/client/localOutbox';
import type { QueueMessage, QueueSnapshot } from '../../../../shared/remote-chat/queue';

it('clears a failed preview when the PC receipt arrives after timeout without resending', async () => {
  let reject!: (error: Error) => void;
  let messages: QueueMessage[] = [];
  const deliver = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
  const outbox = new LocalOutbox({ deliver, changed: queues => { messages = queues.chat ?? []; } });
  outbox.enqueue({ scope: 'chat', thread: null, selectionGeneration: 1, synchronization: 1 },
    { text: 'same text', access: 'read-only' }, { model: 'model', effort: 'high', access: 'read-only' });
  const id = messages[0].id;
  reject(new Error('timeout'));
  await vi.waitFor(() => expect(messages[0].error).toBe('timeout'));
  const receipt: QueueSnapshot = { revision: 1, threads: { chat: [
    { id: 'pc-message', clientId: id, text: 'same text', busy: false, imageCount: 0, attachmentCount: 0 },
  ] } };
  outbox.observe(receipt);
  expect(messages).toEqual([]);
  expect(deliver).toHaveBeenCalledTimes(1);
});

it('does not confirm a different submission with identical text', async () => {
  let reject!: (error: Error) => void;
  let messages: QueueMessage[] = [];
  const deliver = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
  const outbox = new LocalOutbox({ deliver, changed: queues => { messages = queues.chat ?? []; } });
  outbox.enqueue({ scope: 'chat', thread: null, selectionGeneration: 1, synchronization: 1 },
    { text: 'same text', access: 'read-only' }, { model: 'model', effort: 'high', access: 'read-only' });
  reject(new Error('timeout'));
  await vi.waitFor(() => expect(messages[0].error).toBe('timeout'));
  outbox.observe({ revision: 1, threads: { chat: [
    { id: 'other', clientId: 'another-phone', text: 'same text', imageCount: 0, attachmentCount: 0, busy: false },
  ] } });
  expect(messages).toHaveLength(1);
  expect(deliver).toHaveBeenCalledTimes(1);
});
