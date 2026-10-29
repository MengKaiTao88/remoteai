import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.join(root, '.codex-tmp/lounge-files/android');
const serial = process.env.ANDROID_SERIAL;
assert.ok(serial, 'Set ANDROID_SERIAL to a physical test device');
const app = 'com.codexswitch.mobile.loungefilestest';
const adb = async (...args) => (await exec('adb', ['-s', serial, ...args], {
  encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
})).stdout.trim();
async function nodes() {
  await adb('shell', 'uiautomator', 'dump', '/sdcard/lounge-files.xml');
  const xml = await adb('shell', 'cat', '/sdcard/lounge-files.xml');
  return [...xml.matchAll(/<node\b([^>]*)>/g)].map(match => Object.fromEntries(
    [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(attribute => [attribute[1], attribute[2]
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))])));
}
async function find(label) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const node = (await nodes()).find(item => item.text === label || item['content-desc'] === label);
    if (node) return node;
    await delay(300);
  }
  assert.fail(`Missing native label: ${label}`);
}
async function tap(label, picker = false) {
  const node = await find(label);
  const focus = await adb('shell', 'dumpsys', 'window');
  assert.ok(focus.split('\n').some(line => line.includes('mCurrentFocus=') &&
    (line.includes(app) || picker && line.includes('documentsui'))), 'Another app took focus; stop without tapping');
  const [left, top, right, bottom] = [...node.bounds.matchAll(/\d+/g)].map(value => Number(value[0]));
  const x = String(Math.round((left + right) / 2)), y = String(Math.round((top + bottom) / 2));
  await adb('shell', 'input', 'touchscreen', 'swipe', x, y, x, y, '100');
  await delay(300);
}
async function screenshot(name) {
  await adb('shell', 'screencap', '-p', '/sdcard/lounge-files.png');
  await adb('pull', '/sdcard/lounge-files.png', path.join(output, `${name}.png`));
}

const previousScale = await adb('shell', 'settings', 'get', 'system', 'font_scale');
await mkdir(output, { recursive: true });
const run = Date.now();
try {
  for (const scale of [1, 1.3]) {
    const name = `lounge-${run}-${scale}.bin`;
    const content = Buffer.alloc(700001, scale === 1 ? 149 : 174);
    const local = path.join(output, 'source.bin'); await writeFile(local, content);
    await adb('push', local, `/sdcard/Download/${name}`);
    await adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
      '-d', `file:///sdcard/Download/${name}`);
    await adb('shell', 'settings', 'put', 'system', 'font_scale', String(scale));
    await adb('shell', 'am', 'force-stop', app);
    await adb('shell', 'am', 'start', '-W', '-n', `${app}/com.codexswitch.mobile.MainActivity`);
    await tap(scale === 1 ? 'Dark fixture' : 'Light fixture');
    await tap('在线交流'); await tap('添加内容'); await find('发送文件');
    await screenshot(`actions-${scale}`);
    await tap('发送文件');
    await tap('显示根目录', true); await tap('下载内容', true);
    await tap(name, true);
    await find(name); await screenshot(`file-${scale}`);
    await tap(name);
    await delay(2000);
    await adb('pull', `/sdcard/Download/Remote AI/${name}`, path.join(output, `saved-${scale}.bin`));
    assert.deepEqual(await readFile(path.join(output, `saved-${scale}.bin`)), content);
    await tap('返回'); await find('在线交流');
    console.log(`Native file picker and streaming save passed at font scale ${scale}`);
  }
} catch (error) { await screenshot('failure'); throw error; }
finally {
  await adb('shell', 'settings', 'put', 'system', 'font_scale', previousScale);
  await adb('shell', 'am', 'force-stop', app);
}
