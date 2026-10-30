// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { LoungeProfiles } from '../../../../shared/lounge/profiles';
import { LoungeController } from '../../../../shared/lounge/controller';
import { historyScope } from '../../../../shared/lounge/archive';
import type { LoungeMessage } from '../../../../shared/lounge/types';

it('hides legacy account addresses in history and quotes without rewriting user content or identity', () => {
  const message: LoungeMessage = { type: 'message', id: 'old', sentAt: new Date().toISOString(), images: [],
    text: 'user@example.test', sender: { id: 'one', account: 'same@one.test', nickname: 'nickname@example.test' },
    recipient: { id: 'two', account: 'same@two.test', remark: 'private@example.test' },
    reply: { id: 'original', senderId: 'three', account: 'quoted@three.test', text: 'quote@example.test', imageCount: 0 },
  };
  const profiles = new LoungeProfiles();
  const displayed = profiles.message(message);
  expect(displayed).toMatchObject({ text: message.text,
    sender: { id: 'one', account: 'same', nickname: 'nickname@example.test' },
    recipient: { id: 'two', account: 'same', remark: 'private@example.test' },
    reply: { account: 'quoted', text: 'quote@example.test' } });
  expect(message.sender.account).toBe('same@one.test');
  expect(profiles.message(displayed)).toBe(displayed);
});

it('keeps history scopes distinct when public account prefixes match', () => {
  const make = (account: string) => new LoungeController({ baseUrl: 'https://chat.test', account,
    authorize: async () => ({ ticket: 'unused' }) });
  const first = make('same@one.test'), second = make('same@two.test');
  expect(first.historyScope).toBe(historyScope('https://chat.test', 'same@one.test'));
  expect(first.historyScope).not.toBe(second.historyScope);
});

it('restores the signed-in identity offline by ID when another user shares its prefix', async () => {
  const message: LoungeMessage = { type: 'message', id: 'offline', sentAt: new Date().toISOString(), images: [],
    text: 'history', sender: { id: 'other', account: 'same' }, recipient: { id: 'self', account: 'same' } };
  const controller = new LoungeController({ baseUrl: 'https://chat.test', account: 'same@one.test', userId: 'self',
    history: { save: async () => {}, page: async () => ({ messages: [message] }) },
    authorize: async () => { throw new Error('offline'); } });
  try {
    controller.start();
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(controller.snapshot().user).toMatchObject({ id: 'self', account: 'same' });
    expect(controller.snapshot().contacts.map(contact => contact.user.id)).toEqual(['other']);
  } finally { controller.stop(); }
});
