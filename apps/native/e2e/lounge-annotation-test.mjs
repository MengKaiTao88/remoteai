import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.join(root, '.codex-tmp/lounge-annotation-android');
const serial = process.env.ANDROID_SERIAL;
assert.ok(serial, 'Set ANDROID_SERIAL to a physical test device');
const app = 'com.codexswitch.mobile.loungeannotationtest';
const adb = async (...args) => (await exec('adb', ['-s', serial, ...args], {
  encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
})).stdout.trim();
async function nodes() {
  await adb('shell', 'uiautomator', 'dump', '/sdcard/lounge-annotation.xml');
  const xml = await adb('shell', 'cat', '/sdcard/lounge-annotation.xml');
  return [...xml.matchAll(/<node\b([^>]*)>/g)].map(match => Object.fromEntries(
    [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(attribute => [attribute[1], attribute[2]
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))])));
}
const bounds = node => [...node.bounds.matchAll(/\d+/g)].map(value => Number(value[0]));
async function find(label) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const node = (await nodes()).find(item => item.text === label || item['content-desc'] === label);
    if (node) return node;
    await delay(350);
  }
  assert.fail(`Missing native label: ${label}`);
}
async function tap(label) {
  const focus = await adb('shell', 'dumpsys', 'window');
  assert.ok(focus.split('\n').some(line => line.includes('mCurrentFocus=') && line.includes(app)),
    'Another app has taken focus; stop without tapping its controls');
  const [left, top, right, bottom] = bounds(await find(label));
  await adb('shell', 'input', 'tap', String(Math.round((left + right) / 2)), String(Math.round((top + bottom) / 2)));
  await delay(300);
}
async function screenshot(name) {
  await adb('shell', 'screencap', '-p', '/sdcard/lounge-annotation.png');
  await adb('pull', '/sdcard/lounge-annotation.png', path.join(output, `${name}.png`));
}
async function draw() {
  const [left, top, right, bottom] = bounds(await find('图片标注画布'));
  const point = fraction => [left + (right - left) * fraction, top + (bottom - top) * fraction]
    .map(value => String(Math.round(value)));
  await adb('shell', 'input', 'swipe', ...point(0.25), ...point(0.75), '450');
}

const previousScale = await adb('shell', 'settings', 'get', 'system', 'font_scale');
await mkdir(output, { recursive: true });
try {
  await adb('install', '-r', path.join(root,
    '.codex-tmp/lounge-annotation-build/outputs/apk/release/lounge-annotation-fixture.apk'));
  for (const scale of [1, 1.3]) {
    await adb('shell', 'settings', 'put', 'system', 'font_scale', String(scale));
    await adb('shell', 'am', 'force-stop', app);
    await adb('shell', 'am', 'start', '-W', '-n', `${app}/com.codexswitch.mobile.MainActivity`);
    await tap(scale === 1 ? 'Dark fixture' : 'Light fixture');
    await tap('在线交流'); await find('标注图片 1');
    await screenshot(`draft-${scale}`);
    await tap('标注图片 1'); await find('图片标注'); await draw();
    await tap('取消'); await find('标注图片 1');
    await tap('标注图片 1'); await find('图片标注'); await draw();
    await screenshot(`editor-${scale}`);
    await tap('完成'); await find('标注图片 1');
    await screenshot(`saved-${scale}`);
    await tap('发送'); await find('Edited image sent');
    await screenshot(`sent-${scale}`);
    await tap('返回'); await find('在线交流');
    console.log(`Native lounge annotation passed at font scale ${scale}`);
  }
} catch (error) {
  await screenshot('failure');
  throw error;
} finally {
  await adb('shell', 'settings', 'put', 'system', 'font_scale', previousScale);
  await adb('shell', 'am', 'force-stop', app);
}
