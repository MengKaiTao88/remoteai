import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./conversation.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const source = Buffer.from(bundle.outputFiles[0].contents).toString('base64');
const { ConversationViewer } = await import(`data:text/javascript;base64,${source}`);
const threadId = '88d277db-bb40-460a-a062-5b87cab490ee';

function request(id, operation, body = {}) {
  return { id, kind: 'request', method: 'request', body: { operation, threadId, ...body } };
}

test('passive history and explicit resume preserve the native thread and turn IDs', async () => {
  const operations = [];
  const native = { call: async (operation, body) => {
    operations.push([operation, body.threadId]);
    if (operation === 'resume') return { connected: true };
    return { id: threadId, connected: false, turns: [{ id: 'native-turn', messages: [
      { id: 'native-item', kind: 'userMessage', text: 'Existing conversation' },
    ] }] };
  } };
  const viewer = new ConversationViewer(native, 'phone', () => {});
  try {
    const { data } = await viewer.execute(request('history', 'read'));
    assert.equal(data.thread.id, threadId);
    assert.equal(data.thread.turns[0].id, 'native-turn');
    assert.equal(data.thread.turns[0].items[0].id, 'native-item');
    assert.deepEqual(await viewer.execute(request('resume', 'resume')), { kind: 'response', id: 'resume', data: {} });
    assert.deepEqual(operations, [['view', threadId], ['view', threadId], ['resume', threadId]]);
  } finally { viewer.close(); }
});

test('retrying the same Web submission after service restart keeps the native submission ID', async () => {
  const deliveries = [];
  const native = { call: async (operation, body) => {
    if (operation === 'view') return { id: threadId, connected: true };
    assert.equal(operation, 'send');
    deliveries.push(body);
    return { status: 'accepted' };
  } };
  const before = new ConversationViewer(native, 'phone-before', () => {});
  const after = new ConversationViewer(native, 'phone-after', () => {});
  const message = { clientId: 'local-outbox-message', text: 'Continue this conversation' };
  const first = request('original', 'send', message);
  const reply = await before.execute(first);
  assert.deepEqual(reply, { kind: 'response', id: 'original', data: {} });
  assert.deepEqual(await before.execute(first), reply);
  await after.execute(request('retried', 'send', message));
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].threadId, threadId);
  assert.match(deliveries[0].submissionId, /^[\da-f-]{36}$/);
  assert.deepEqual(deliveries[1], deliveries[0]);
  before.close();
  after.close();
});
