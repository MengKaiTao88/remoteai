import assert from 'node:assert/strict';

function size(node) {
  const [left, top, right, bottom] = [...node.bounds.matchAll(/\d+/g)].map(value => Number(value[0]));
  return { width: right - left, height: bottom - top };
}

/** Short messages must retain their full advance width when their bubble shrinks to fit. */
export async function verifyNativeText(options) {
  const { adb, tap, find, screenshot, hideKeyboard, scale, broadcast, incoming } = options;
  await tap('查看 bob 的资料'); await tap('发消息');
  await tap('消息'); await adb('shell', 'input', 'text', 'hi'); await tap('发送');
  await hideKeyboard();
  const short = size(await find('hi'));
  await screenshot(`short-text-${scale}`);
  console.log(`Short message at scale ${scale}: ${JSON.stringify(short)}`);
  assert.ok(short.width > 0 && short.height > 0, 'The short message has visible text bounds');
  const receive = text => broadcast({ ...incoming(text),
    recipient: { id: 'alice', account: 'alice@example.test' }, receipts: true });
  receive('你好');
  const chinese = size(await find('你好'));
  assert.ok(chinese.height <= short.height + 1, 'Chinese short text stays on one complete line');
  await tap('消息'); await adb('shell', 'input', 'text', 'hi-hi-hi'); await tap('发送');
  await hideKeyboard();
  const repeated = size(await find('hi-hi-hi'));
  assert.ok(Math.abs(repeated.height - short.height) <= 1, 'Short words share the same single-line height');
  assert.ok(repeated.width > short.width, 'Bubbles expand to fit their text');
  receive('第一行\n第二行');
  const multiline = size(await find('第一行\n第二行'));
  assert.ok(multiline.height > chinese.height, 'Explicit line breaks grow the message');
  receive('长消息需要完整换行，'.repeat(6));
  const long = size(await find('长消息需要完整换行，'.repeat(6)));
  assert.ok(long.height > multiline.height, 'Wrapped Chinese text grows with every line');
  await screenshot(`mixed-text-${scale}`);
  await verifyOwnProfile(options);
  await verifyQuotes(options);
  await tap('返回聊天列表'); await find('新聊天');
  await screenshot(`text-back-${scale}`);
}

async function verifyOwnProfile({ tap, find, screenshot, scale, profile, image, fail, saves }) {
  await tap('查看 alice 的资料'); await find('个人资料');
  await screenshot(`self-profile-${scale}`);
  await tap('修改头像'); await find('设置头像'); await tap('取消'); await find('修改头像');
  profile(image); await tap('修改头像'); await find('恢复默认头像');
  fail(true); await tap('保存'); await find('头像保存失败，请稍后重试。');
  fail(false); await tap('恢复默认头像'); await tap('保存'); await find('修改头像');
  assert.equal(saves().at(-1), '', 'Own profile avatar changes must be saved');
  await screenshot(`self-profile-saved-${scale}`); await tap('返回');
}

async function verifyQuotes(options) {
  const { tap, find, screenshot, scale, broadcast, incoming, image, adb, hideKeyboard } = options;
  await tap('返回聊天列表'); await tap('群聊');
  const receive = broadcast;
  const text = '第一行完整引用\n第二行中文 😀\n第三行也应完整显示';
  const original = incoming(text, [image]); receive(original);
  const reply = { id: original.id, senderId: 'bob', account: 'bob@example.test', text, imageCount: 1 };
  receive({ ...incoming('quote-response'), reply });
  await find('quote-response'); await find('查看原消息');
  await screenshot(`quote-full-${scale}`);
  await tap('查看原消息'); await screenshot(`quote-located-${scale}`);
  await find('回到最新消息'); await tap('回到最新消息');
  for (let index = 0; index < 220; index++) receive(incoming(`archive-filler-${index}`));
  receive({ ...incoming('archive-response'), reply }); await find('archive-response');
  await tap('消息'); await adb('shell', 'input', 'text', 'Draft'); await hideKeyboard();
  await tap('查看原消息'); await find(text); await find('Draft');
  await screenshot(`quote-archive-${scale}`); await tap('回到最新消息'); await find('archive-response');
  receive({ ...incoming('missing-response'), reply: { ...reply, id: 'missing' } });
  await find('missing-response'); await tap('查看原消息');
  await find('原消息未保存在本机，暂时无法定位。');
}
