import { expect, it } from 'vitest';
import { mergeHistory } from '../../../../shared/remote-chat/client/history';
import { LiveHistory } from './liveHistory';
import type { Thread, Turn } from '../../../../shared/conversation/types';

const turn = (id: string, startedAt?: number): Turn => ({ id, startedAt, status: 'completed',
  items: [{ id: `${id}-message`, type: 'agentMessage', text: id }] });
const thread = (turns: Turn[]): Thread => ({ id: 'chat', cwd: '', preview: '', updatedAt: 1, turns });
const order = (value: Thread) => value.turns?.map(entry => entry.id);

it('keeps older cached turns before a disjoint latest snapshot without losing their messages', () => {
  const older = thread([turn('greeting', 100), turn('earlier-task', 200)]);
  const latest = thread([turn('continue', 300)]);
  const merged = mergeHistory(latest, older, thread([]), { retainCached: true });
  expect(order(merged)).toEqual(['greeting', 'earlier-task', 'continue']);
  expect(merged.turns?.[0].items).toEqual(older.turns?.[0].items);
  expect(order(mergeHistory(latest, merged, merged, { retainCached: true }))).toEqual(order(merged));
});

it('uses shared neighbours to insert retained turns when old servers omit timestamps', () => {
  const live = thread([turn('old'), turn('middle'), turn('missing'), turn('last'), turn('new')]);
  const snapshot = thread([turn('middle'), turn('last')]);
  expect(order(mergeHistory(snapshot, live, thread([]), { retainCached: true })))
    .toEqual(['old', 'middle', 'missing', 'last', 'new']);
});

it('places replayed historical turns before the latest reply even when live arrival order is wrong', () => {
  const snapshot = thread([turn('latest', 300)]);
  const live = thread([turn('latest', 300), turn('greeting', 100), turn('earlier-task', 200)]);
  expect(order(mergeHistory(snapshot, live, thread([]), { retainCached: true })))
    .toEqual(['greeting', 'earlier-task', 'latest']);
});

it('uses UUIDv7 creation times when a retained historical turn has no startedAt', () => {
  const old = '01a1c460-8e18-7e83-8502-2ef13d2f0b1d';
  const latest = '01a1c69d-a906-7b01-9c4f-597ac7dff490';
  expect(order(mergeHistory(thread([turn(latest)]), thread([turn(old)]), thread([]), { retainCached: true })))
    .toEqual([old, latest]);
});

it('keeps the authoritative snapshot order when its timestamps disagree', () => {
  const snapshot = thread([turn('server-first', 400), turn('server-last', 200)]);
  const live = thread([turn('server-last', 200), turn('server-first', 400)]);
  expect(order(mergeHistory(snapshot, live, thread([]), { retainCached: true })))
    .toEqual(['server-first', 'server-last']);
});

it('does not resurrect a completed cached turn removed by an authoritative refresh', () => {
  const cached = thread([turn('deleted', 100), turn('keep', 200)]);
  expect(order(mergeHistory(thread([turn('keep', 200)]), cached, cached, true))).toEqual(['keep']);
});

it('keeps a running turn at the tail after retaining older host snapshots', async () => {
  const history = new LiveHistory();
  history.receive({ method: 'turn/completed', params: { threadId: 'chat', turn: turn('greeting', 100) } });
  await history.read('chat', async () => ({ thread: thread([turn('greeting', 100)]) }));
  const current = { ...turn('current', 300), status: 'inProgress' };
  history.receive({ method: 'item/completed', params: { threadId: 'chat', turnId: 'current', item: current.items[0] } });
  const snapshot = thread([turn('middle', 200), current]);
  expect(order(await history.read('chat', async () => ({ thread: snapshot }))))
    .toEqual(['greeting', 'middle', 'current']);
});
