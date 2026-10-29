import assert from 'node:assert/strict';

export async function verifyNativeAdminBadge(options) {
  const { adb, tap, find, nodes, screenshot, hideKeyboard, scale, broadcast, incoming } = options;
  assert.ok(!(await nodes()).some(node => node.text === '管理员'), 'Ordinary messages have no badge');
  broadcast({ type: 'policy', policy: { moderator: false, mutedUntil: null } });
  broadcast({ ...incoming('管理员发来的消息'), sender: {
    id: 'manager', account: 'manager@example.test', nickname: '管理员的长昵称需要完整换行显示', moderator: true,
  } });
  await find('管理员发来的消息'); await find('管理员');
  await screenshot(`admin-incoming-${scale}`);
  broadcast({ type: 'policy', policy: { moderator: true, mutedUntil: null } });
  await tap('消息'); await adb('shell', 'input', 'text', 'Admin-own'); await tap('发送');
  await hideKeyboard(); await find('Admin-own');
  await find('管理员');
  await screenshot(`admin-both-${scale}`);
  await tap('添加内容'); await tap('历史记录'); await find('管理员');
  const labels = (await nodes()).filter(node => node.text === '管理员');
  assert.equal(labels.length, 2, 'History preserves own and incoming moderator badges');
  await screenshot(`admin-history-${scale}`); await tap('返回聊天');
  await tap('返回聊天列表'); await find('搜索聊天'); await tap('返回发现');
  await tap('English'); await tap('Online Chat'); await tap('Group chat');
  await find('Admin'); await screenshot(`admin-english-${scale}`);
}
