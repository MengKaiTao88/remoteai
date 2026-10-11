import { expect, it } from 'vitest';
import { completedTurnFiles, conversationEntries, findWorkEntry, groupTurnItems } from './turnPresentation';
import type { Item, Turn } from './types';
import { CONTINUE_MESSAGE } from '../../../../shared/remote-chat/composerAction';

it('reuses historical rows while replacing the streamed turn', () => {
  const old: Turn = { id: 'old', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Done' }] };
  const live: Turn = { id: 'live', status: 'inProgress', items: [{ id: 'stream', type: 'agentMessage', text: 'A' }] };
  const before = conversationEntries([old, live]);
  const updated = { ...live, items: [{ ...live.items[0], text: 'AB' }] };
  const after = conversationEntries([old, updated]);
  expect(after[0]).toBe(before[0]);
  expect(after[1]).not.toBe(before[1]);
  expect(after[1]).toMatchObject({ item: { text: 'AB' } });
});

it.each(['interrupted', 'failed'])('keeps %s continuation and activity modes separate in the row cache', (status) => {
  const previous: Turn = { id: 'previous', status: 'completed', items: [] };
  const turn: Turn = { id: 'turn', status: 'completed', items: [
    { id: 'continue', type: 'userMessage', content: [{ type: 'text', text: CONTINUE_MESSAGE }] },
    { id: 'tool', type: 'commandExecution' },
  ] };
  const collapsed = conversationEntries([previous, turn]);
  const expanded = conversationEntries([previous, turn], new Map([[turn.id, true]]));
  expect(expanded.some((entry) => entry.kind === 'process')).toBe(true);
  expect(collapsed.some((entry) => entry.kind === 'process')).toBe(false);
  const continuation = conversationEntries([{ ...previous, status }, turn]);
  expect(continuation.some((entry) => entry.id === 'turn:message:continue')).toBe(false);
  expect(conversationEntries([previous, turn])[0]).toBe(collapsed[0]);
});

it('keeps user steering and final replies in order while grouping process messages', () => {
  const items: Item[] = [
    { id: 'user', type: 'userMessage' },
    { id: 'thinking', type: 'reasoning' },
    { id: 'update', type: 'agentMessage', phase: 'commentary' },
    { id: 'command', type: 'commandExecution' },
    { id: 'steer', type: 'userMessage' },
    { id: 'edit', type: 'fileChange' },
    { id: 'final', type: 'agentMessage', phase: 'final_answer' },
  ];
  expect(groupTurnItems(items).map((group) => [group.type, group.items.map((item) => item.id)])).toEqual([
    ['message', ['user']], ['work', ['thinking', 'update', 'command']], ['message', ['steer']],
    ['work', ['edit']], ['message', ['final']],
  ]);
  expect(groupTurnItems([{ id: 'legacy', type: 'agentMessage' }])[0].type).toBe('message');
});

it('shows live commentary and tools inline with stable addresses as output and the final answer arrive', () => {
  const turn: Turn = { id: 'turn', status: 'inProgress', items: [
    { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Working' },
  ] };
  const entry = conversationEntries([turn])[0];
  const updated = conversationEntries([{ ...turn, items: [...turn.items,
    { id: 'shell', type: 'commandExecution' }, { id: 'answer', type: 'agentMessage', phase: 'final_answer' },
  ] }]);
  expect(updated[0].id).toBe(entry.id);
  expect(updated.map((value) => value.kind)).toEqual(['work', 'process', 'process', 'message']);
  expect(updated[1].id).toBe(conversationEntries([turn])[1].id);
  expect(updated[0]).toMatchObject({ inline: true });
  expect(updated[1]).toMatchObject({ item: { id: 'progress', text: 'Working' } });
  const streamed = conversationEntries([{ ...turn, items: [turn.items[0], {
    id: 'shell', type: 'commandExecution', status: 'inProgress', aggregatedOutput: 'STEP-2',
  }] }]);
  expect(streamed[2]).toMatchObject({ id: updated[2].id, item: { aggregatedOutput: 'STEP-2' } });
});

it('keeps all 65 activities as individual list cells, in order around user steering', () => {
  const activities: Item[] = Array.from({ length: 65 }, (_, index) => ({
    id: `tool-${index}`, type: 'commandExecution', status: 'completed',
  }));
  const entries = conversationEntries([{ id: 'turn', status: 'inProgress', items: [
    ...activities.slice(0, 30), { id: 'steer', type: 'userMessage' }, ...activities.slice(30),
  ] }]);
  expect(entries.flatMap((entry) => entry.kind === 'process' ? [entry.item.id] : []))
    .toEqual(activities.map((item) => item.id));
  expect(entries.slice(30, 34).map((entry) => entry.id)).toEqual([
    'turn:message:tool-29', 'turn:message:steer', 'turn:work:tool-30', 'turn:message:tool-30',
  ]);
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
});

it.each(['completed', 'failed', 'interrupted'])('preserves reading choices when a turn becomes %s', (status) => {
  const turn: Turn = { id: 'turn', status: 'inProgress', items: [{ id: 'tool', type: 'commandExecution' }] };
  const finished: Turn = { ...turn, status };
  expect(conversationEntries([finished], new Map([[turn.id, true]])).filter((entry) => entry.kind === 'process'))
    .toMatchObject([{ id: 'turn:message:tool' }]);
  expect(conversationEntries([finished], new Map([[turn.id, false]]))
    .filter((entry) => entry.kind === 'process')).toEqual([]);
  expect(conversationEntries([finished])[0]).toMatchObject({ kind: 'work', inline: status !== 'completed' });
});

it('does not expand older completed turns when the next turn starts', () => {
  const turns: Turn[] = [
    { id: 'old', status: 'completed', items: [{ id: 'old-tool', type: 'commandExecution' }] },
    { id: 'live', status: 'inProgress', items: [{ id: 'live-tool', type: 'commandExecution' }] },
  ];
  expect(conversationEntries(turns).filter((entry) => entry.kind === 'work')
    .map((entry) => entry.inline)).toEqual([false, true]);
});

it('preserves live activity IDs when earlier items in the same group load', () => {
  const turn: Turn = { id: 'turn', status: 'inProgress', items: [{ id: 'tail', type: 'commandExecution' }] };
  const before = conversationEntries([turn]);
  const after = conversationEntries([{ ...turn, items: [
    { id: 'earlier', type: 'reasoning', summary: ['Inspect'] }, ...turn.items,
  ] }]);
  expect(after.at(-1)?.id).toBe(before.at(-1)?.id);
  expect(findWorkEntry(after, before[0].id)?.items.map((item) => item.id)).toEqual(['earlier', 'tail']);
});

it('retains every turn plan, failure, interruption and changes instead of only the latest turn', () => {
  const turns: Turn[] = [
    { id: 'plan', status: 'completed', items: [], plan: [{ step: 'Verify', status: 'completed' }] },
    { id: 'failure', status: 'failed', items: [], error: { message: 'Request failed' } },
    { id: 'stop', status: 'interrupted', items: [] },
    { id: 'continue', status: 'inProgress', items: [
      { id: 'auto', type: 'userMessage', content: [{ type: 'text', text: CONTINUE_MESSAGE }] },
      { id: 'answer', type: 'agentMessage', text: 'Continued' },
    ] },
  ];
  expect(conversationEntries(turns).map((entry) => [entry.turn.id, entry.kind])).toEqual([
    ['plan', 'summary'], ['failure', 'summary'], ['stop', 'summary'], ['continue', 'message'],
  ]);
});

it('excludes failed and unfinished patches and prefers final net changes', () => {
  const turn: Turn = { id: 'turn', status: 'completed', items: ['completed', 'failed', 'declined', 'inProgress']
    .map((status) => ({ id: status, type: 'fileChange', status,
      changes: [{ path: `${status}.ts`, kind: { type: 'add' }, diff: 'one\n' }] })) };
  expect(completedTurnFiles(turn).map((file) => file.path)).toEqual(['completed.ts']);
  expect(completedTurnFiles({ ...turn, diff: '--- a/net.ts\n+++ b/net.ts\n@@ -1 +1 @@\n-old\n+new\n' }))
    .toMatchObject([{ path: 'net.ts', added: 1, removed: 1 }]);
});

it('places the completed duration before the response without adding empty summary cells', () => {
  const turn: Turn = { id: 'turn', status: 'completed', durationMs: 2500, items: [
    { id: 'question', type: 'userMessage' }, { id: 'answer', type: 'agentMessage', text: 'Done' },
  ] };
  expect(conversationEntries([turn]).map((entry) => entry.kind)).toEqual(['message', 'duration', 'message']);
  expect(conversationEntries([{ ...turn, status: 'inProgress', durationMs: undefined }])
    .map((entry) => entry.kind)).toEqual(['message', 'message']);
});

it('keeps the open process group addressable after loading an earlier page of the same turn', () => {
  const turn: Turn = { id: 'turn', status: 'completed', items: [{ id: 'tail', type: 'commandExecution' }] };
  const selectedId = conversationEntries([turn])[0].id;
  const entries = conversationEntries([{ ...turn, items: [
    { id: 'earlier', type: 'reasoning', summary: ['Inspect'] }, ...turn.items,
  ] }]);
  expect(findWorkEntry(entries, selectedId)?.items.map((item) => item.id)).toEqual(['earlier', 'tail']);
  expect(findWorkEntry(entries, 'another-turn:work:tail')).toBeUndefined();
});

it('automatically folds a completed live turn and keeps its duration on the drawer entry', () => {
  const turn: Turn = { id: 'turn', status: 'inProgress', items: [
    { id: 'question', type: 'userMessage' }, { id: 'tool', type: 'commandExecution' },
  ] };
  expect(conversationEntries([turn]).some((entry) => entry.kind === 'process')).toBe(true);
  const finished = { ...turn, status: 'completed', durationMs: 2500 };
  const entries = conversationEntries([finished]);
  expect(entries.map((entry) => entry.kind)).toEqual(['message', 'work']);
  expect(entries[1]).toMatchObject({ timed: true, inline: false });
  expect(findWorkEntry(entries, 'turn:work:tool')?.items).toEqual([turn.items[1]]);
});

it('excludes empty process items without losing a stable drawer address or final answer', () => {
  const turn: Turn = { id: 'turn', status: 'completed', items: [
    { id: 'empty', type: 'reasoning', summary: ['  '] },
    { id: 'blank', type: 'agentMessage', phase: 'commentary', text: ' ' },
    { id: 'tool', type: 'commandExecution' },
    { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Done' },
  ] };
  expect(conversationEntries([turn])).toMatchObject([
    { id: 'turn:work:empty', items: [{ id: 'tool' }] }, { kind: 'message', item: { id: 'final' } },
  ]);
  expect(conversationEntries([{ ...turn, items: turn.items.slice(0, 2) }])).toEqual([]);
});
