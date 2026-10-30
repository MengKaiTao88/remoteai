import assert from 'node:assert/strict';

export async function verifyNativeNotifications({ adb, tap, find, nodes, screenshot, longPress, scale,
  broadcast, incoming, notifications, restart }) {
  const close = () => adb('shell', 'input', 'keyevent', '4');
  const direct = '与 bob 私聊';
  broadcast({ ...incoming('私聊未读消息'), recipient: { id: 'alice', account: 'alice@example.test' } });
  await find(direct);
  for (let index = 0; index < 100; index++) broadcast(incoming(`群聊未读消息 ${index}`));
  await find('99+'); await longPress('群聊'); await find('消息免打扰');
  await screenshot(`notifications-group-menu-${scale}`); await tap('消息免打扰');
  assert.ok(notifications.muted.has(''));
  await longPress(direct); await tap('消息免打扰');
  assert.ok(notifications.muted.has('bob'));
  await find('99+'); await screenshot(`notifications-list-${scale}`);
  await tap('返回发现'); await find('在线交流');
  assert.ok(!(await nodes()).some(node => node.text === '99+' || node.text === '1'), 'Muted entry badges must disappear');
  await screenshot(`notifications-entry-${scale}`); await tap('在线交流');
  notifications.fail = true;
  await longPress(direct); await tap('取消免打扰'); await find('未能保存免打扰设置，请稍后重试。');
  assert.ok(notifications.muted.has('bob'));
  notifications.fail = false;
  await longPress(direct); await tap('取消免打扰');
  assert.ok(!notifications.muted.has('bob'));
  await tap('返回发现'); await find('1');
  notifications.update('bob', true); await tap('在线交流');
  await longPress(direct); await find('取消免打扰'); await close();
  await restart();
  await longPress('群聊'); await find('取消免打扰'); await close();
  broadcast({ ...incoming('重连后的私聊'), recipient: { id: 'alice', account: 'alice@example.test' } });
  await longPress(direct); await find('取消免打扰'); await close();
  await tap(direct); await find('消息'); await tap('返回聊天列表'); await find('群聊');
  await tap('返回发现'); await tap('English'); await tap('Online Chat');
  await longPress('Group chat'); await find('Unmute notifications');
  await screenshot(`notifications-english-${scale}`); await close();
  console.log(`PASS native notification settings, badges, restart and navigation at font scale ${scale}`);
}
