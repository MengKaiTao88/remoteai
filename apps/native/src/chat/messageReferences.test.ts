import { expect, it } from 'vitest';
import { messageReferences } from '../../../../shared/chat/messageReferences';
import { messageContent } from '../../../../shared/chat/messageDetails';
import { updateThread } from '../../../../shared/remote-chat/client/events';
import { mergeHistory } from '../../../../shared/remote-chat/client/history';
import { MESSAGE_ACKNOWLEDGED } from '../../../../shared/chat/acknowledgedMessages';
import type { Content } from '../../../desktop/src/pages/codexGui/types';
import type { Item, Thread } from './types';

const mention = { type: 'mention', name: '设计讨论', path: 'codex-thread://design' };
const envelope = '<codex_gui_conversation_context>' + JSON.stringify({
  kind: 'reference', id: 'design', name: mention.name, messages: ['PRIVATE CONTEXT'],
}) + '</codex_gui_conversation_context>';
const user = (content: Content[] | string[]): Item => ({ id: 'user', type: 'userMessage', content });
const thread = (items: Item[]): Thread => ({ id: 'chat', cwd: '', preview: '', updatedAt: 1,
  turns: [{ id: 'turn', status: 'inProgress', items }] });

it('shows live mentions and legacy envelopes without exposing their context in text or copy', () => {
  for (const item of [user([{ type: 'text', text: '继续这个任务' }, mention]),
    user([`继续这个任务\n${envelope}`]), { ...user([]), text: `继续这个任务\n${envelope}` }]) {
    expect(messageContent(item)).toBe('继续这个任务');
    expect(messageReferences(item)).toEqual([{ kind: 'conversation', path: mention.path,
      name: mention.name, label: '引用对话' }]);
  }
});

it('deduplicates a reference across representations but keeps distinct conversations with the same title', () => {
  const item = user([mention, { ...mention, path: 'codex-thread://other' },
    { type: 'text', text: envelope }]);
  expect(messageReferences(item).map(reference => reference.path)).toEqual([mention.path, 'codex-thread://other']);
  expect(messageContent(item)).toBe('');
  expect(messageReferences({ ...item, type: 'agentMessage' })).toEqual([]);
});

it('preserves references from send acknowledgement through server replacement and history refresh', () => {
  const echo = { ...user([mention]), id: 'sent-user', localEcho: true };
  const initial = thread([]);
  const live = updateThread(initial, { method: MESSAGE_ACKNOWLEDGED,
    params: { threadId: 'chat', turnId: 'turn', item: echo, userMessageIndex: 0 } });
  const server = user([{ type: 'text', text: envelope }]);
  const confirmed = updateThread(live, { method: 'item/completed',
    params: { threadId: 'chat', turnId: 'turn', item: server } });
  const history = mergeHistory(thread([server]), confirmed, confirmed);
  for (const value of [live, confirmed, history]) {
    expect(value.turns![0].items).toHaveLength(1);
    expect(messageReferences(value.turns![0].items[0])[0]?.name).toBe(mention.name);
  }
});

it('hides malformed reserved context while retaining ordinary messages and other attachment labels', () => {
  expect(messageContent(user(['继续\n<codex_gui_conversation_context>{broken']))).toBe('继续');
  expect(messageReferences(user(['<codex_gui_conversation_context>{broken']))).toEqual([]);
  expect(messageReferences(user([{ type: 'mention', name: 'GitHub', path: 'plugin://github@openai' },
    { type: 'mention', name: 'notes.md', path: 'C:/project/notes.md' }])).map(reference => reference.label))
    .toEqual(['插件', '附件']);
});
