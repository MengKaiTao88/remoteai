// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoungeController } from '../../../../shared/lounge/controller';
import { LoungeNames, accountMatches, accountName, validName } from '../../../../shared/lounge/names';
import { mergeContact, parseAccount } from '../../../../shared/lounge/contacts';
import { quoteMessage } from '../../../../shared/lounge/reply';

const self = { id: 'alice', account: 'alice' };
const bob = { id: 'bob', account: 'bob' };
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn();
  constructor() { Socket.instances.push(this); }
  frame(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  ready(names = true) { this.frame({ type: 'ready', user: self, profiles: true, names, direct: true, receipts: true }); }
}
let controller: LoungeController;
let savedContact = vi.fn();
beforeEach(async () => {
  vi.useFakeTimers(); Socket.instances = []; vi.stubGlobal('WebSocket', Socket);
  savedContact = vi.fn(async () => {});
  controller = new LoungeController({ baseUrl: 'https://example.test', authorize: async () => ({ ticket: 'ticket' }),
    history: { save: async () => {}, page: async () => ({ messages: [] }), saveContact: savedContact } });
  controller.start();
  for (let i = 0; i < 8; i++) await Promise.resolve();
});
afterEach(() => { controller.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('server-backed lounge names', () => {
  it('prefers private remarks, searches all identifiers, and keeps clears through cache merges', () => {
    const names = new LoungeNames(); names.ready(self, true);
    names.receive({ profiles: [{ id: bob.id, nickname: '小明' }], remarks: [{ id: bob.id, remark: '同事 Bob' }] });
    const user = names.user(bob);
    expect(accountName(user)).toBe('同事 Bob');
    for (const query of ['小明', '同事', 'BOB']) expect(accountMatches(user, query)).toBe(true);
    names.receive({ remarks: [{ id: bob.id, remark: '' }] });
    const cleared = names.user(user);
    expect(accountName(cleared)).toBe('小明');
    expect(mergeContact([{ user, direct: true }], { user: cleared, direct: true })[0].user.remark).toBe('');
    names.receive({ profiles: [{ id: bob.id, nickname: '' }] });
    expect(accountName(names.user(cleared))).toBe(bob.account);
    names.clear(); names.ready({ id: 'other', account: 'other@example.test' }, true);
    expect(names.user(bob)).toEqual(bob);
  });

  it('validates Unicode by code points and refuses unsupported or failed writes', async () => {
    expect(validName('😀'.repeat(32), 32)).toBe(true);
    expect(validName('😀'.repeat(33), 32)).toBe(false);
    expect(validName('line\nbreak', 64)).toBe(false);
    expect(validName('line\u2028break', 64)).toBe(false);
    expect(parseAccount({ ...bob, nickname: '\u0000', remark: 'x'.repeat(65) })).toEqual({ ...bob, avatar: undefined });
    const names = new LoungeNames(); const submit = vi.fn();
    await expect(names.save({ kind: 'nickname', userId: self.id, value: 'Alice' }, submit)).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled(); names.ready(self, true);
    submit.mockRejectedValue(new Error('internal details'));
    await expect(names.save({ kind: 'remark', userId: bob.id, value: 'Bob' }, submit))
      .rejects.toThrow('client.lounge.remarkSaveFailed');
    expect(names.user(bob)).toEqual(bob);
  });

  it('applies sync before save acknowledgement and never sends private labels in messages or quotes', async () => {
    const socket = Socket.instances[0]; socket.ready(); controller.selectConversation(bob);
    const save = controller.setName({ kind: 'remark', userId: bob.id, value: ' My colleague ' });
    const request = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    expect(request).toMatchObject({ type: 'remark', userId: bob.id, remark: 'My colleague' });
    socket.frame({ type: 'names', remarks: [{ id: bob.id, remark: request.remark }] });
    socket.frame({ type: 'updated', id: request.id }); await save;
    expect(controller.snapshot().contacts[0].user.remark).toBe('My colleague');
    socket.frame({ type: 'message', id: 'incoming', text: 'Hello', images: [], sender: bob,
      recipient: self, sentAt: new Date().toISOString() });
    const message = controller.snapshot().messages[0];
    expect(message.sender.remark).toBe('My colleague');
    const reply = quoteMessage(message); expect(reply.account).toBe(bob.account);
    const sending = controller.send({ text: 'Reply', images: [], reply });
    const outgoing = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    expect(JSON.stringify(outgoing)).not.toContain('My colleague');
    socket.frame({ ...outgoing, type: 'message', sender: self, recipient: bob, sentAt: new Date().toISOString() });
    await sending;
    socket.frame({ type: 'names', remarks: [{ id: bob.id, remark: '' }] });
    expect(controller.snapshot().contacts[0].user.remark).toBe('');
  });

  it('requires server capability and rejects an interrupted save without changing the visible name', async () => {
    const socket = Socket.instances[0]; socket.ready(false);
    await expect(controller.setName({ kind: 'nickname', userId: self.id, value: 'Alice' })).rejects.toThrow();
    socket.ready();
    const save = controller.setName({ kind: 'nickname', userId: self.id, value: 'Alice' });
    socket.onclose?.();
    await expect(save).rejects.toThrow('client.lounge.nicknameSaveFailed');
    expect(controller.snapshot().user?.nickname).toBe('');
  });

  it('persists cleared names when a delayed message still carries the old nickname', async () => {
    const socket = Socket.instances[0]; socket.ready();
    controller.selectConversation({ ...bob, nickname: 'Old', remark: 'Private' });
    socket.frame({ type: 'names', profiles: [{ id: bob.id, nickname: '' }], remarks: [{ id: bob.id, remark: '' }] });
    socket.frame({ type: 'message', id: 'late', sender: { ...bob, nickname: 'Old' },
      recipient: self, text: 'Delayed', images: [], sentAt: new Date().toISOString() });
    for (let i = 0; i < 16; i++) await Promise.resolve();
    expect(savedContact.mock.calls.at(-1)?.[0].user).toMatchObject({ nickname: '', remark: '' });
    expect(accountName(controller.snapshot().contacts[0].user)).toBe(bob.account);
  });
});
