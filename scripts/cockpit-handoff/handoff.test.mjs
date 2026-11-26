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

const nativeModels = [
  { id: 'sol', name: 'Sol', defaultEffort: 'medium', efforts: ['medium', 'high'], isDefault: true },
  { id: 'astra', name: 'Astra', defaultEffort: 'high', efforts: ['medium', 'high'] },
];

test('a new Web conversation can load the native model catalog before it has a thread ID', async () => {
  const operations = [];
  const native = { call: async (operation, body) => {
    operations.push([operation, body.threadId]);
    assert.equal(operation, 'models');
    return { models: nativeModels };
  } };
  const viewer = new ConversationViewer(native, 'phone', () => {});
  try {
    await viewer.execute(request('show-old', 'viewThread'));
    const { data } = await viewer.execute(request('new-models', 'models', { threadId: null }));
    assert.deepEqual(data.data.map(model => model.model), ['sol', 'astra']);
    assert.equal(data.composer.threadId, null);
    assert.deepEqual(operations, [['models', null]]);
  } finally { viewer.close(); }
});

test('saving the model and effort in an existing Web conversation returns confirmed native settings', async () => {
  let view = { id: threadId, connected: true, model: 'sol', effort: 'medium' };
  const native = { call: async (operation, body) => {
    assert.equal(body.threadId, threadId);
    if (operation === 'view') return view;
    if (operation === 'models') return { models: nativeModels };
    assert.equal(operation, 'settings');
    view = { ...view, ...body.settings };
    return view;
  } };
  const viewer = new ConversationViewer(native, 'phone', () => {});
  const reply = await viewer.execute(request('save', 'composerSet', { settings: { model: 'astra', effort: 'high' } }));
  assert.equal(reply.error, undefined);
  assert.equal(reply.data.threadId, threadId);
  assert.equal(reply.data.settings.model, 'astra');
  assert.equal(reply.data.settings.effort, 'high');
});

test('reopening a conversation waits for native metadata before displaying its last saved settings', async () => {
  let loaded = false;
  const native = { call: async (operation, body) => {
    assert.equal(body.threadId, threadId);
    if (operation === 'models') {
      loaded = true;
      return { models: nativeModels, currentModel: 'astra', currentEffort: 'high' };
    }
    assert.equal(operation, 'view');
    return { id: threadId, connected: false, ...(loaded ? { model: 'astra', effort: 'high', permissionMode: 'ask' }
      : { loadingHistory: true, permissionMode: 'custom' }) };
  } };
  const viewer = new ConversationViewer(native, 'phone', () => {});
  const reply = await viewer.execute(request('reopen', 'models'));
  assert.deepEqual(reply.data.composer.settings, { model: 'astra', effort: 'high', access: 'read-only' });
});

test('a first Web message creates and then sends to the native desktop thread', async () => {
  const operations = [];
  let connected = false;
  const native = { call: async (operation, body) => {
    operations.push([operation, body]);
    if (operation === 'resume') return { connected: connected = true };
    if (operation === 'send') return { status: 'accepted' };
    return { id: threadId, connected, model: 'sol', effort: 'medium' };
  } };
  const viewer = new ConversationViewer(native, 'phone', () => {});
  const created = await viewer.execute(request('first', 'start', { threadId: null }));
  assert.equal(created.data.thread.id, threadId);
  assert.match(operations[0][1].requestId, /^[\da-f-]{36}$/);
  const sent = await viewer.execute(request('send', 'send', { threadId: created.data.thread.id,
    text: 'The first message', model: 'sol', effort: 'medium' }));
  assert.equal(sent.error, undefined);
  assert.deepEqual(operations.map(([operation]) => operation), ['start', 'view', 'view', 'resume', 'view', 'send']);
  assert.equal(operations.at(-1)[1].threadId, threadId);
});

test('Web history expands its older page using stable native item anchors', async () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({ id: `turn-${i}`,
    messages: [{ id: `reply-${i}`, kind: 'agentMessage', text: `Reply ${i}` }] }));
  const viewer = new ConversationViewer({ call: async () => ({ id: threadId, connected: false, turns }) },
    'phone', () => {});
  try {
    const tail = await viewer.execute(request('tail', 'syncHistory', { window: { pageSize: 2 } }));
    assert.deepEqual(tail.data.order, ['turn-3', 'turn-4']);
    const older = await viewer.execute(request('older', 'syncHistory', {
      window: { start: tail.data.page.start, pageSize: 2, older: true } }));
    assert.deepEqual(older.data.order, ['turn-1', 'turn-2', 'turn-3', 'turn-4']);
    assert.equal(older.data.page.start.itemId, 'reply-1');
  } finally { viewer.close(); }
});

test('reaching the saved history boundary loads native older turns', async () => {
  const makeTurn = i => ({ id: `turn-${i}`, messages: [{ id: `reply-${i}`, kind: 'agentMessage', text: `Reply ${i}` }] });
  const native = { call: async operation => operation === 'olderHistory'
    ? { id: threadId, historyComplete: true, turns: [0, 1, 2].map(makeTurn) }
    : { id: threadId, historyComplete: false, turns: [makeTurn(2)] } };
  const viewer = new ConversationViewer(native, 'phone', () => {});
  try {
    const tail = await viewer.execute(request('tail', 'syncHistory', { window: { pageSize: 2 } }));
    assert.equal(tail.data.page.hasMore, true);
    const prior = await viewer.execute(request('prior', 'syncHistory', {
      window: { start: tail.data.page.start, older: true, pageSize: 2 } }));
    assert.deepEqual(prior.data.order, ['turn-0', 'turn-1', 'turn-2']);
    assert.equal(prior.data.page.hasMore, false);
  } finally { viewer.close(); }
});

test('a history process summary can open its original tool details', async () => {
  const messages = [{ id: 'command', kind: 'commandExecution', text: 'verify', output: 'result' },
    { id: 'tool', kind: 'tool', title: 'test tool', output: 'tool output' }];
  const native = { call: async () => ({ id: threadId, connected: true, turns: [{ id: 'turn', messages }] }) };
  const viewer = new ConversationViewer(native, 'phone', () => {});
  const process = await viewer.execute(request('process', 'processDetails',
    { turnId: 'turn', itemId: 'command', endItemId: 'tool' }));
  assert.deepEqual(process.data.items.map(item => item.id), ['command', 'tool']);
  const tool = await viewer.execute(request('tool-details', 'toolDetails', { turnId: 'turn', itemId: 'command' }));
  assert.equal(tool.data.item.aggregatedOutput, 'result');
});

test('pin and archive actions return confirmed state for the selected native conversation', async () => {
  const native = { call: async (operation, body) => {
    assert.equal(body.threadId, threadId);
    if (operation === 'pin') return body.pinned ? [threadId] : [];
    assert.equal(operation, 'archive');
    assert.match(body.requestId, /^[\da-f-]{36}$/);
    return { status: 'confirmed', archived: body.archived };
  } };
  const viewer = new ConversationViewer(native, 'phone', () => {});
  const pin = await viewer.execute(request('pin', 'threadPin', { pinned: true }));
  assert.deepEqual(pin.data.pins, [threadId]);
  const archive = await viewer.execute(request('archive', 'archive'));
  assert.equal(archive.data.archived, true);
  const unarchive = await viewer.execute(request('unarchive', 'unarchive'));
  assert.equal(unarchive.data.archived, false);
});

test('an explicit native archive refusal stays visible to the Web client', async () => {
  const reason = 'Archive this conversation in the Codex client that currently owns it.';
  const native = { call: async () => ({ status: 'rejected', reason }) };
  const viewer = new ConversationViewer(native, 'phone', () => {});
  const reply = await viewer.execute(request('archive-held', 'archive'));
  assert.equal(reply.error, reason);
});
