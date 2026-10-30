import assert from 'node:assert/strict';

const lookupLabel = '完整邮箱前缀或邮箱';

export async function verifyNativeNewChat(options) {
  const { adb, tap, find, nodes, screenshot, hideKeyboard, scale, sent, lookups, lookupReply } = options;
  await screenshot(`new-chat-entry-${scale}`);
  await tap('新聊天'); await find('最近发言用户');
  await screenshot(`new-chat-recent-${scale}`);
  const recentQueries = lookups.length;
  await tap('与 bob 私聊'); await find('bob');
  assert.equal(lookups.length, recentQueries, 'Recent speakers open directly');
  await tap('返回聊天列表');
  await tap('新聊天');
  await fillLookup(options, 'bo'); await tap('发起私聊'); await find('未找到该用户，请检查输入后重试。');
  await fillLookup(options, 'shared'); await tap('发起私聊'); await find('多个用户使用此前缀，请输入完整邮箱。');
  await hideKeyboard(); await screenshot(`new-chat-error-${scale}`);
  await fillLookup(options, 'alice@example.test'); await tap('发起私聊');
  await find('这是你自己的账号，请输入对方的邮箱。');
  await fillLookup(options, 'BOB');
  await screenshot(`new-chat-keyboard-${scale}`);
  await tap('发起私聊'); await find('bob');
  assert.equal(lookups.at(-1), 'BOB');
  await tap('消息'); await adb('shell', 'input', 'text', `Prefix-${scale}`); await tap('发送');
  await find('对方已收到'); assert.equal(sent.at(-1).to, 'bob');
  await hideKeyboard(); await screenshot(`new-chat-private-${scale}`);
  await tap('返回聊天列表'); await tap('新聊天');
  await fillLookup(options, 'bob@EXAMPLE.test'); await tap('发起私聊'); await find('bob');
  assert.equal(lookups.at(-1), 'bob@EXAMPLE.test');
  await tap('返回聊天列表'); await tap('群聊');
  await tap('消息'); await adb('shell', 'input', 'text', 'PreservedDraft'); await hideKeyboard();
  await tap('返回聊天列表'); await tap('新聊天');
  lookupReply(false); await fillLookup(options, 'bob'); await tap('发起私聊');
  await hideKeyboard(); await adb('shell', 'input', 'keyevent', '4');
  await find('搜索聊天'); lookupReply(true);
  await tap('群聊'); await find('PreservedDraft');
  await tap('返回聊天列表'); await tap('新聊天');
  const field = await find(lookupLabel);
  assert.equal(field.text, lookupLabel, 'Reopening clears the previous search');
  await screenshot(`new-chat-reopen-${scale}`);
  await adb('shell', 'input', 'keyevent', '4'); await find('搜索聊天');
  await tap('返回发现'); await find('在线交流');
  await tap('English'); await tap('Online Chat'); await tap('New chat'); await find('Recent speakers');
  await screenshot(`new-chat-english-${scale}`);
  assert.ok(!(await nodes()).some(node => node.text.includes('client.lounge.')), 'All new copy is translated');
  console.log(`PASS native new chat at font scale ${scale}: recent users, prefix, email, errors, cancel and navigation`);
}

async function fillLookup({ adb, tap, find }, text) {
  const field = await find(lookupLabel);
  await tap(lookupLabel);
  if (field.text && field.text !== lookupLabel) {
    await adb('shell', 'input', 'keyevent', '123');
    await adb('shell', 'input', 'keyevent', ...Array.from(field.text, () => '67'));
  }
  await adb('shell', 'input', 'text', text);
}
