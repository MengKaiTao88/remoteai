import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const LATEST = '回到最新消息';
const hasLatest = nodes => nodes.some(node => node.text === LATEST || node['content-desc'] === LATEST);
function viewport(nodes) {
  const list = nodes.find(node => node.scrollable === 'true');
  assert.ok(list, 'The message list must be scrollable');
  return [...list.bounds.matchAll(/\d+/g)].map(value => Number(value[0]));
}

export async function verifyNativeLoungeScroll({ adb, tap, find, nodes, screenshot, scale, broadcast, incoming, app }) {
  await tap('群聊');
  for (let index = 0; index < 60; index++) broadcast(incoming(`滚动测试第 ${index + 1} 条中文消息`));
  await find('滚动测试第 60 条中文消息');
  let current = await nodes();
  assert.ok(!hasLatest(current), 'No latest shortcut at the bottom');
  assert.ok(!current.some(node => node.text.startsWith('消息保存在本机')), 'No persistent storage notice at the bottom');
  const bounds = viewport(current);
  const [left, top, right, bottom] = bounds;
  const x = String(Math.round((left + right) / 2));
  const start = String(Math.round(top + (bottom - top) * 0.25));
  const end = String(Math.round(top + (bottom - top) * 0.65));
  const moveUp = async () => {
    const focus = await adb('shell', 'dumpsys', 'window');
    assert.ok(focus.split('\n').some(line => line.includes('mCurrentFocus=') && line.includes(app)),
      'Another application took focus; stop without tapping');
    await adb('shell', 'input', 'swipe', x, start, x, end, '900');
    await delay(400);
  };
  await moveUp();
  current = await nodes();
  assert.ok(!hasLatest(current), 'A partial page of content below must not show the latest shortcut');
  await screenshot(`scroll-less-than-page-${scale}`);
  await moveUp(); await moveUp(); await moveUp();
  await find(LATEST);
  assert.ok(!(await nodes()).some(node => node.text === LATEST), 'The latest shortcut displays only an arrow');
  assert.deepEqual(viewport(await nodes()), bounds, 'Showing the shortcut must not resize the message list');
  await screenshot(`scroll-one-page-${scale}`);
  await tap('返回聊天列表'); await tap('群聊'); await find(LATEST);
  await tap(LATEST); await find('滚动测试第 60 条中文消息');
  assert.ok(!hasLatest(await nodes()), 'The shortcut disappears after returning to the latest message');
  await screenshot(`scroll-latest-${scale}`);
  await tap('返回聊天列表'); await find('搜索聊天');
  console.log(`PASS native latest shortcut at font scale ${scale}: one page, stable layout, restore and return`);
}
