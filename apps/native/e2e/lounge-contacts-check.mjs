import assert from 'node:assert/strict';

export async function verifyNativeContacts({ tap, find, nodes, screenshot, scale, restart, addContact }) {
  await find('与 bob 私聊');
  await screenshot(`cloud-contacts-${scale}`);
  await tap('与 bob 私聊'); await find('bob');
  assert.ok(!(await nodes()).some(node => node.text.includes('真机中文测试')), 'Cloud contacts do not replay messages');
  await tap('返回聊天列表');
  await restart();
  await find('与 bob 私聊');
  addContact({ id: 'carol', account: 'carol@example.test' });
  await find('与 carol 私聊');
  await screenshot(`cloud-contacts-restored-${scale}`);
  await tap('与 carol 私聊'); await find('carol');
  await tap('返回聊天列表'); await find('搜索聊天');
  console.log(`PASS native cloud contacts at font scale ${scale}: clean login, live sync, no message replay`);
}
