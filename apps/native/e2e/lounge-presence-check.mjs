import assert from 'node:assert/strict';

export async function verifyNativePresence({ adb, tap, find, nodes, screenshot, scale, broadcast, incoming, image }) {
  await find('搜索聊天');
  assert.ok(!(await nodes()).some(node => node.text === '消息'), 'Discovery opens the list');
  broadcast({ ...incoming('私聊未读消息'), recipient: { id: 'alice', account: 'alice@example.test' } });
  await find('与 bob 私聊');
  await screenshot(`presence-online-${scale}`);
  broadcast({ type: 'contacts', contacts: [{ id: 'bob', online: false }] });
  await screenshot(`presence-offline-${scale}`);
  broadcast({ type: 'contacts', contacts: [{ id: 'bob', online: null }] });
  await screenshot(`presence-hidden-${scale}`);
  broadcast({ type: 'profiles', profiles: [{ id: 'bob', avatar: image }] });
  broadcast({ type: 'contacts', contacts: [{ id: 'bob', online: true }] });
  await screenshot(`presence-picture-${scale}`);
  await tap('与 bob 私聊'); await find('私聊未读消息');
  await tap('返回聊天列表'); await find('搜索聊天');
  await tap('返回发现'); await find('在线交流');
  await tap('在线交流'); await find('搜索聊天');
  assert.ok(!(await nodes()).some(node => node.text === '消息'), 'Re-entry does not reopen the private conversation');
  await tap('群聊'); await find('真机中文测试：忙里偷闲，聊点轻松的 ☕');
  await adb('shell', 'input', 'keyevent', '4'); await find('搜索聊天');
  await adb('shell', 'input', 'keyevent', '4'); await find('在线交流');
  await tap('在线交流'); await find('搜索聊天');
  await screenshot(`presence-reentry-${scale}`);
  console.log(`PASS native chat list and presence at font scale ${scale}`);
}
