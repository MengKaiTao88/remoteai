import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const serial = process.env.ANDROID_SERIAL;
assert.ok(serial, 'Set ANDROID_SERIAL to a physical Android device');
const app = 'com.codexswitch.mobile.portmappingtest';
const output = fileURLToPath(new URL('../../../.codex-tmp/port-mapping-android/', import.meta.url));
const adb = async (...args) => (await exec('adb', ['-s', serial, ...args],
  { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const oldScale = await adb('shell', 'settings', 'get', 'system', 'font_scale');
await mkdir(output, { recursive: true });

async function nodes() {
  await adb('shell', 'uiautomator', 'dump', '/sdcard/port-mapping-ui.xml');
  const xml = await adb('shell', 'cat', '/sdcard/port-mapping-ui.xml');
  return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(match =>
    Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(value => [value[1], value[2]])));
}
async function tap(label, options = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const current = await nodes();
    const candidates = current.filter(node => (node['content-desc'] === label || node.text === label
      || options.includes && node['content-desc']?.includes(label)) && (!options.class || node.class === options.class));
    const node = candidates[options.index ?? 0];
    if (node) {
      const [left, top, right, bottom] = node.bounds.match(/\d+/g).map(Number);
      if (bottom > top && right > left) {
        await adb('shell', 'input', 'tap', String((left + right) >> 1), String((top + bottom) >> 1));
        await delay(250); return;
      }
    }
    await adb('shell', 'input', 'swipe', '540', '1850', '540', '900', '350');
  }
  throw new Error(`Could not find ${label}`);
}
async function screenshot(name) {
  const image = await exec('adb', ['-s', serial, 'exec-out', 'screencap', '-p'],
    { encoding: 'buffer', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  await writeFile(`${output}/${name}.png`, image.stdout);
}
async function add(name, port) {
  await tap('添加映射');
  await tap('电脑', { class: 'android.widget.Button' });
  await tap(name, { class: 'android.widget.Button' });
  await tap('远程端口', { class: 'android.widget.EditText' });
  await adb('shell', 'input', 'text', '8080');
  await tap('本地端口', { class: 'android.widget.EditText' });
  await adb('shell', 'input', 'text', String(port));
  await adb('shell', 'input', 'keyevent', '4');
  await tap('添加并启动');
  await delay(500);
}
async function reachable(port, device) {
  await adb('forward', `tcp:${port}`, `tcp:${port}`);
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2_000) });
      assert.equal(await response.text(), `mapped-${device}`); return;
    } catch (error) { if (attempt === 14) throw error; await delay(500); }
  }
}

try {
  await adb('shell', 'am', 'force-stop', app);
  await adb('shell', 'pm', 'clear', app);
  await adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0');
  await adb('shell', 'am', 'start', '-n', `${app}/com.codexswitch.mobile.MainActivity`);
  await delay(2_000);
  await screenshot('discovery-1.0');
  await tap('端口映射', { includes: true });
  await add('办公电脑', 18081);
  await reachable(18081, 'one');
  console.log('First device listener receives bytes');
  await add('家用电脑', 18082);
  await reachable(18082, 'two');
  await screenshot('mappings-1.0');
  await tap('返回发现');
  await reachable(18081, 'one'); await reachable(18082, 'two');
  console.log('Both listeners survive leaving the page');
  await tap('Disconnect fixture');
  await tap('Reconnect fixture');
  await reachable(18081, 'one'); await reachable(18082, 'two');
  console.log('Both listeners resume after disconnect');
  await adb('shell', 'am', 'force-stop', app);
  await adb('shell', 'am', 'start', '-n', `${app}/com.codexswitch.mobile.MainActivity`);
  await reachable(18081, 'one'); await reachable(18082, 'two');
  console.log('Enabled mappings restore after process restart');
  await adb('shell', 'settings', 'put', 'system', 'font_scale', '1.3');
  await delay(1_000);
  await screenshot('discovery-1.3');
  await tap('端口映射', { includes: true });
  await screenshot('mappings-1.3');
  await tap('添加映射');
  await tap('电脑', { class: 'android.widget.Button' });
  await tap('家用电脑', { class: 'android.widget.Button' });
  await screenshot('form-1.3');
  await tap('取消');
  await tap('停止映射', { class: 'android.widget.Switch' });
  await screenshot('stopped-1.3');
  await tap('返回发现');
  console.log('Default/enlarged Chinese text, mapping form and back navigation captured');
} finally {
  await adb('shell', 'settings', 'put', 'system', 'font_scale', oldScale === 'null' ? '1.0' : oldScale);
  await adb('shell', 'am', 'force-stop', app);
  await adb('forward', '--remove', 'tcp:18081');
  await adb('forward', '--remove', 'tcp:18082');
}
