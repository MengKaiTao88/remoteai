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
    await scroll(current);
  }
  throw new Error(`Could not find ${label}`);
}
async function scroll(current) {
  const view = (current ?? await nodes()).find(node => node.scrollable === 'true');
  assert.ok(view, 'Expected scrollable content');
  const [left, top, right, bottom] = view.bounds.match(/\d+/g).map(Number);
  const x = String(Math.round((left + right) / 2));
  await adb('shell', 'input', 'swipe', x, String(Math.round(top + (bottom - top) * 0.75)),
    x, String(Math.round(top + (bottom - top) * 0.6)), '650');
}
async function screenshot(name) {
  await nodes();
  await delay(500);
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
  await tap('保存');
  const start = (await nodes()).find(node => node['content-desc'] === '启动映射');
  assert.equal(start?.checked, 'false');
  await screenshot(`saved-${port}`);
  await adb('forward', `tcp:${port}`, `tcp:${port}`);
  await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1_000) }));
  await tap('启动映射', { class: 'android.widget.Switch' });
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
  await tap('添加映射');
  await tap('电脑', { class: 'android.widget.Button' });
  await screenshot('device-picker');
  await tap('家用电脑', { class: 'android.widget.Button' });
  await screenshot('form-1.0');
  await tap('UDP', { class: 'android.widget.RadioButton' });
  await screenshot('form-udp');
  await tap('全部（TCP + UDP）', { class: 'android.widget.RadioButton' });
  await tap('目标 IP说明');
  assert.ok((await nodes()).some(node => node.text === '留空时，访问远程电脑本机。'));
  await screenshot('form-help');
  await tap('目标 IP说明');
  await tap('保存');
  assert.ok((await nodes()).some(node => node.text?.includes('端口') && node.text?.includes('65535')));
  await screenshot('form-validation');
  await tap('取消');
  await add('办公电脑', 18081);
  await reachable(18081, 'one');
  console.log('First device listener receives bytes');
  await add('家用电脑', 18082);
  await reachable(18082, 'two');
  await screenshot('mappings-1.0');
  await tap('修改别名', { class: 'android.widget.Button' });
  await tap('别名', { class: 'android.widget.EditText' });
  await adb('shell', 'input', 'text', 'Home-dev');
  await screenshot('alias-editor');
  await tap('保存');
  assert.ok((await nodes()).some(node => node.text === 'Home-dev'));
  await screenshot('mapping-alias');
  await tap('更多操作');
  await tap('编辑映射');
  assert.ok((await nodes()).some(node => node.text === '保存修改'));
  await tap('取消');
  await tap('更多操作');
  assert.ok((await nodes()).some(node => node.text === '删除映射'));
  await screenshot('mapping-actions');
  await tap('更多操作');
  await tap('复制本地地址');
  assert.ok((await nodes()).some(node => node.text === '本地地址已复制'));
  await tap('打开');
  await delay(500);
  assert.ok((await nodes()).some(node => node.text === 'http://127.0.0.1:18082'));
  await tap('关闭');
  console.log('Edit, menu, copy and open actions work from the redesigned card');
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
  assert.ok((await nodes()).some(node => node.text === 'Home-dev'));
  console.log('Saving leaves listeners stopped; the local alias survives restart');
  await tap('修改别名');
  await screenshot('alias-editor-1.3');
  await tap('取消');
  await tap('添加映射');
  await tap('电脑', { class: 'android.widget.Button' });
  await tap('家用电脑', { class: 'android.widget.Button' });
  await screenshot('form-1.3');
  await scroll();
  await screenshot('form-1.3-actions');
  await tap('取消');
  await tap('停止映射', { class: 'android.widget.Switch' });
  await screenshot('stopped-1.3');
  await tap('返回发现');
  await tap('Dark');
  await tap('端口映射', { includes: true });
  await tap('修改别名');
  await screenshot('alias-editor-dark-1.3');
  await tap('取消');
  await tap('添加映射');
  await screenshot('form-dark-1.3');
  await tap('取消');
  await tap('English');
  await tap('Add mapping');
  await screenshot('form-english-dark-1.3');
  assert.ok((await nodes()).some(node => node.text === 'Choose computer'));
  await scroll();
  await screenshot('form-english-dark-1.3-actions');
  await tap('Cancel');
  console.log('Default/enlarged Chinese text, mapping form and back navigation captured');
} finally {
  await adb('shell', 'settings', 'put', 'system', 'font_scale', oldScale === 'null' ? '1.0' : oldScale);
  await adb('shell', 'am', 'force-stop', app);
  await adb('forward', '--remove', 'tcp:18081');
  await adb('forward', '--remove', 'tcp:18082');
}
