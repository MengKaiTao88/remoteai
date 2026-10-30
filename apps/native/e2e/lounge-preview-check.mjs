import assert from 'node:assert/strict';

export async function verifyNativePreview({ adb, tap, find, nodes, screenshot, scale, broadcast, incoming }) {
  const receive = text => broadcast({ ...incoming(text),
    recipient: { id: 'alice', account: 'alice@example.test' }, receipts: true });
  receive('较早的未读消息');
  const latest = '最新未读消息的文字部分\n很长的文字需要单行显示，超过可用宽度后使用省略号。';
  receive(latest);
  const preview = latest.replace('\n', ' ');
  await find(preview);
  await find('与 bob 私聊');
  await assertNoSelection(nodes);
  await screenshot(`preview-unread-${scale}`);
  await tap('与 bob 私聊'); await find(latest);
  await tap('返回聊天列表'); await find(preview);
  await assertNoSelection(nodes);
  assert.ok(!(await nodes()).some(node => node.text === '2'), 'Reading clears the private unread badge');
  await screenshot(`preview-read-${scale}`);
  await tap('与 bob 私聊');
  await tap('消息'); await adb('shell', 'input', 'text', 'My-reply'); await tap('发送');
  await find('My-reply');
  const keyboard = await adb('shell', 'dumpsys', 'input_method');
  if (keyboard.includes('mInputShown=true')) await adb('shell', 'input', 'keyevent', '4');
  await tap('返回聊天列表'); await find('My-reply');
  await tap('群聊'); await find('真机中文测试：忙里偷闲，聊点轻松的 ☕');
  await adb('shell', 'input', 'keyevent', '4'); await find('搜索聊天');
  await assertNoSelection(nodes);
  await screenshot(`preview-return-${scale}`);
  console.log(`PASS native unread previews and unselected chat list at font scale ${scale}`);
}

async function assertNoSelection(nodes) {
  const list = await nodes();
  assert.ok(!list.some(node => node.text === '当前'), 'Chat rows never show a current label');
  assert.ok(!list.some(node => node.selected === 'true'), 'Chat rows do not announce a selected state');
}
