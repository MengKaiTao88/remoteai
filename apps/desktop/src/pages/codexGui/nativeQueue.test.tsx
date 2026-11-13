// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { QueuedMessages } from './QueuedMessages';
import { reduceEvent } from '../../../../../shared/conversation/events';
import { applyChatEvent } from '../../../../../shared/remote-chat/client/events';
import { initialChatState } from '../../../../../shared/remote-chat/client/types';
import { queueProps } from '../../../../../shared/remote-chat/client/queueProps';
import { initialState } from './preferences';
import type { MessageQueue } from './messageQueue';
import type { ChatController } from '../../../../../shared/remote-chat/client/controller';
import { mergeHistory } from '../../../../../shared/remote-chat/client/history';

const nativeQueue = [{ id: 'native-1', text: 'owner queued task', imageCount: 0 }];
const thread = { id: 'thread', cwd: '', preview: '', updatedAt: 1, turns: [] };
const event = { method: 'thread/nativeQueue/updated', params: { threadId: thread.id, nativeQueue } };

it('keeps a newer queue event across an older history response and preserves unknown queue capability', () => {
  const before = { ...thread, nativeQueue };
  const live = { ...before, nativeQueue: [] };
  expect(mergeHistory(before, live, before).nativeQueue).toEqual([]);
  expect(mergeHistory(thread, before, before).nativeQueue).toEqual(nativeQueue);
  expect(mergeHistory({ ...before, nativeQueue: [] }, before, before).nativeQueue).toEqual([]);
});

it('updates local and remote owner queues without touching an unrelated local failed draft', () => {
  const draft = { id: 'local-1', text: 'local task', images: [], skills: [], model: '', effort: '',
    access: 'read-only' as const, error: 'kept local error' };
  const state = { ...initialState(), queued: { thread: [draft] }, conversations: {
    thread: { thread, turns: [], activeTurn: null, tokens: 0, error: '' },
  } };
  const local = reduceEvent(state, event);
  expect(local.conversations.thread.thread.nativeQueue).toEqual(nativeQueue);
  expect(local.queued).toBe(state.queued);
  const remote = applyChatEvent({ ...initialChatState(), selected: thread }, event);
  const props = queueProps(remote, {} as ChatController);
  expect(props.messages).toEqual([expect.objectContaining({ id: 'official:native-1', official: true,
    text: 'owner queued task', busy: false })]);
  const cleared = applyChatEvent(remote, { ...event, params: { threadId: thread.id, nativeQueue: [] } });
  expect(queueProps(cleared, {} as ChatController).messages).toEqual([]);
});

it('shows the owner queue read-only without a false error or any local dispatch controls', async () => {
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  const queue = { flush: vi.fn(), move: vi.fn(), remove: vi.fn(), steer: vi.fn() };
  try {
    await act(async () => root.render(<QueuedMessages threadId="thread" messages={[]} nativeQueue={nativeQueue}
      running connected queue={queue as unknown as MessageQueue} editDisabled={false} onEdit={vi.fn()} />));
    expect(element.textContent).toContain('Codex');
    expect(element.textContent).toContain('owner queued task');
    expect(element.querySelector('[role="status"]')).toBeNull();
    expect(element.querySelectorAll('button')).toHaveLength(0);
    expect(queue.flush).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); element.remove(); }
});
