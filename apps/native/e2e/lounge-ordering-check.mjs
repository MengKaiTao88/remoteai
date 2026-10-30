import assert from 'node:assert/strict';

export async function verifyNativeOrdering(options) {
  const { adb, tap, find, nodes, screenshot, longPress, hideKeyboard, scale, broadcast, incoming, restart } = options;
  const label = id => `与 ${id} 私聊`;
  const receive = (id, sentAt) => broadcast({ ...incoming(`${id}-${sentAt}`),
    sender: { id, account: `${id}@example.test` }, recipient: { id: 'alice', account: 'alice@example.test' },
    sentAt: new Date(sentAt).toISOString(), receipts: true });
  const order = async expected => {
    await find(label(expected[0])); await find(label(expected[1]));
    const labels = (await nodes()).map(node => node['content-desc']).filter(value =>
      value === label('bob') || value === label('carol'));
    assert.deepEqual(labels, expected.map(label));
  };
  receive('bob', Date.now() - 4000); await find(label('bob'));
  receive('carol', Date.now() - 2000); await order(['carol', 'bob']);
  await longPress(label('bob')); await find('置顶'); await screenshot(`ordering-menu-${scale}`);
  await tap('置顶'); await find('已置顶'); await order(['bob', 'carol']);
  receive('carol', Date.now()); await order(['bob', 'carol']);
  await longPress(label('carol')); await tap('置顶'); await order(['carol', 'bob']);
  await screenshot(`ordering-pinned-${scale}`);
  await longPress(label('carol')); await tap('取消置顶'); await order(['bob', 'carol']);
  await tap(label('carol')); await tap('消息'); await adb('shell', 'input', 'text', 'Latest-reply');
  await tap('发送'); await find('Latest-reply'); await hideKeyboard();
  await tap('返回聊天列表'); await order(['bob', 'carol']);
  await restart(); await order(['bob', 'carol']); await find('已置顶');
  await screenshot(`ordering-offline-${scale}`);
  await longPress(label('bob')); await tap('取消置顶'); await order(['carol', 'bob']);
  await tap(label('bob')); await tap('返回聊天列表'); await order(['carol', 'bob']);
  await screenshot(`ordering-unpinned-${scale}`);
  await tap('返回发现'); await tap('English'); await tap('Online Chat');
  await longPress('Chat with bob'); await find('Pin');
  await screenshot(`ordering-english-${scale}`);
  console.log(`PASS native ordering, pin/unpin, offline restart and navigation at font scale ${scale}`);
}
