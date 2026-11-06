import { afterEach, expect, it } from 'vitest';
import { setConversationScope, scopedConversationArgs } from '../../../../../shared/platform/conversationScope';

afterEach(() => setConversationScope(undefined));

it('tags chat writes and queues with their originating source without changing unrelated proxy commands', () => {
  const scope = { backend: 'official' as const, revision: 123 };
  const original = { request: { operation: 'send', threadId: 'native-thread' } };
  setConversationScope(scope);
  expect(scopedConversationArgs('codex_gui_request', original)).toEqual({ ...original, scope });
  expect(scopedConversationArgs('codex_gui_queue_save', original)).toEqual({ ...original, scope });
  expect(scopedConversationArgs('start_local_proxy', original)).toBe(original);
  expect(original).not.toHaveProperty('scope');
});

it('preserves the wire shape used by older hosts until they opt into source scoping', () => {
  const args = { request: { operation: 'list' } };
  expect(scopedConversationArgs('codex_gui_request', args)).toBe(args);
});
