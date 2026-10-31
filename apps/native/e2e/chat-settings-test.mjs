import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.join(root, '.codex-tmp/chat-settings-android');
const serial = process.env.ANDROID_SERIAL;
assert.ok(serial, 'Set ANDROID_SERIAL to a physical test device');
const app = 'com.codexswitch.mobile.settingsuitest';
const adb = async (...args) => (await exec('adb', ['-s', serial, ...args], {
  encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
})).stdout.trim();

async function nodes() {
  await adb('shell', 'uiautomator', 'dump', '/sdcard/settings-layout.xml');
  const xml = await adb('shell', 'cat', '/sdcard/settings-layout.xml');
  return [...xml.matchAll(/<node\b([^>]*)>/g)].map(match => Object.fromEntries(
    [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(attribute => [attribute[1], attribute[2]])));
}

async function find(label) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const tree = await nodes();
    const node = tree.find(value => value['content-desc'] === label) ?? tree.find(value => value.text === label);
    if (node) return node;
    await delay(400);
  }
  assert.fail(`Missing native label: ${label}`);
}

const center = node => {
  const [left, top, right, bottom] = [...node.bounds.matchAll(/\d+/g)].map(value => Number(value[0]));
  return [Math.round((left + right) / 2), Math.round((top + bottom) / 2)].map(String);
};
async function tap(label) { await adb('shell', 'input', 'tap', ...center(await find(label))); }
async function checked(label) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await find(label)).checked === 'true') return;
    await delay(250);
  }
  assert.fail(`Expected checked option: ${label}`);
}
async function swipe(from, to) {
  const start = center(await find(from));
  const end = center(await find(to));
  await adb('shell', 'input', 'swipe', ...start, ...end, '650');
  await checked(to);
}
async function screenshot(name) {
  await adb('shell', 'screencap', '-p', '/sdcard/settings-result.png');
  await adb('pull', '/sdcard/settings-result.png', path.join(output, `${name}.png`));
}

async function dragHandle(distance, duration = '650', label = '下拉关闭') {
  const [x, y] = center(await find(label)).map(Number);
  await adb('shell', 'input', 'swipe', String(x), String(y), String(x), String(y + distance), duration);
  await delay(350);
}

async function verifySheetGestures() {
  await dragHandle(80);
  await find('设置模型');
  await dragHandle(-150);
  await find('设置模型');
  await tap('设置模型');
  await find('返回上一层');
  await dragHandle(-500, '650', 'Preview 5');
  await find('返回上一层');
  const entries = (await nodes()).filter(node => /^Preview \d+$/.test(node['content-desc']));
  const middle = entries[Math.floor(entries.length / 2)];
  assert.ok(middle, 'Scrolled model options remain visible');
  await dragHandle(300, '650', middle['content-desc']);
  await find('返回上一层');
  await dragHandle(300);
  await tap('设置模型');
  await dragHandle(260, '650', 'GPT-6-Astra');
  await find('设置模型');
  await tap('设置当前对话的上下文容量');
  await find('上下文容量（K Token）');
  await dragHandle(300);
  await find('设置当前对话的上下文容量');
  await dragHandle(300, '650', '设置模型');
  await tap('聊天设置');
  await find('设置模型');
  console.log('PASS: handle and content drag, rebound, nested return');
}

const originalScale = await adb('shell', 'settings', 'get', 'system', 'font_scale');
try {
  await mkdir(output, { recursive: true });
  await adb('install', '-r', path.join(root,
    'apps/native/android/app/build-chat-settings/outputs/apk/debug/app-debug.apk'));
  for (const scale of [1, 1.3]) {
    await adb('shell', 'settings', 'put', 'system', 'font_scale', String(scale));
    await adb('shell', 'am', 'force-stop', app);
    await adb('shell', 'am', 'start', '-W', '-n', `${app}/com.codexswitch.mobile.MainActivity`);
    await find('极高');
    await delay(600);
    const tree = await nodes();
    assert.ok(!tree.some(node => node.text === '聊天设置' || node['content-desc'] === '关闭聊天设置'));
    assert.ok(tree.some(node => node.text === '今日 437.77M Token · 640.61USD'));
    assert.ok(tree.some(node => node.text === '额度点数 62,500.125'));
    await screenshot(`initial-${scale}`);
    await verifySheetGestures();
    await tap('低');
    await checked('低');
    await swipe('低', 'Ultra');
    await swipe('Ultra', '低');
    await swipe('普通模式', 'Ultrafast 模式');
    await swipe('完全访问', '请求批准');
    await screenshot(`cool-${scale}`);
    await tap('Ultra');
    await tap('普通模式');
    await tap('完全访问');
    await checked('Ultra');
    await checked('普通模式');
    await checked('完全访问');
    await screenshot(`warm-${scale}`);
    await dragHandle(300);
    await tap('聊天设置');
    await tap('设置模型');
    await find('GPT-6-Astra');
    await tap('返回上一层');
    await find('Ultra');
    console.log(`PASS: native selectors, sheet dragging/rebound, nested sheets, close/reopen at font scale ${scale}`);
  }
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, fontScales: [1, 1.3] }));
} finally {
  if (originalScale === 'null') await adb('shell', 'settings', 'delete', 'system', 'font_scale');
  else await adb('shell', 'settings', 'put', 'system', 'font_scale', originalScale);
  await adb('shell', 'am', 'force-stop', app);
  await adb('shell', 'am', 'start', '-W', '-n', 'com.codexswitch.mobile/com.codexswitch.mobile.MainActivity');
}
