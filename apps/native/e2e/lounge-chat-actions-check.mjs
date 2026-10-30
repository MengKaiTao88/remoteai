import assert from 'node:assert/strict';

export async function verifyNativeChatActions({ adb, tap, find, nodes, screenshot, longPress,
  scale, broadcast, incoming }) {
  const direct = '与 bob 私聊';
  broadcast({ ...incoming('抽屉操作测试'), recipient: { id: 'alice', account: 'alice@example.test' } });
  await find(direct); await longPress(direct);
  for (const label of ['发起私聊', '置顶', '屏蔽此人', '删除']) await find(label);
  await screenshot(`chat-actions-${scale}`);
  await tap('置顶'); await find('已置顶');
  await longPress(direct); await tap('取消置顶');
  await longPress(direct); await tap('屏蔽此人'); await tap('取消'); await find(direct);
  await longPress(direct); await tap('删除'); await find('删除这段私聊？'); await tap('取消');
  await longPress(direct); await tap('发起私聊'); await find('消息');
  await tap('返回聊天列表'); await longPress(direct); await adb('shell', 'input', 'keyevent', '4');
  await find('搜索聊天');
  const account = '中文联系人.very.long.email.address';
  broadcast({ ...incoming('长名称'), sender: { id: 'long', account },
    recipient: { id: 'alice', account: 'alice@example.test' } });
  await longPress(`与 ${account} 私聊`); await find(account); await find('删除');
  await screenshot(`chat-actions-long-${scale}`); await tap('取消');
  assert.ok(!(await nodes()).some(node => node.text === '发起私聊'), 'Dismissal returns to the list');
  await tap('返回发现'); await tap('English'); await tap('Online Chat');
  await longPress('Chat with bob'); await find('Send a private message');
  await screenshot(`chat-actions-english-${scale}`); await tap('Cancel');
  console.log(`PASS native chat action sheet, pin, confirmations, dismissal and navigation at font scale ${scale}`);
}
