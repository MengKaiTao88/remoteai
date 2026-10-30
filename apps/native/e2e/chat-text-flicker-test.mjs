import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hierarchy, prepareHierarchy } from '../../desktop/e2e/android-hierarchy.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.join(root, '.codex-tmp/native-flicker-1030/verified');
const serial = process.env.ANDROID_SERIAL;
assert.ok(serial, 'Set ANDROID_SERIAL to the physical Android device');
const applicationId = 'com.codexswitch.mobile.textflickertest';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const adb = async (...args) => (await exec('adb', ['-s', serial, ...args],
  { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout;

async function nodes() {
  const xml = await hierarchy(adb);
  return [...xml.matchAll(/<node\b([^>]*)>/g)].map(match => Object.fromEntries(
    [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(value => [value[1], value[2]])));
}

function bounds(node) {
  assert.ok(node, 'Expected view is present');
  return [...node.bounds.matchAll(/-?\d+/g)].map(value => Number(value[0]));
}

async function tap(label) {
  const target = (await nodes()).find(node => node.text === label);
  const [left, top, right, bottom] = bounds(target);
  await adb('shell', 'input', 'tap', String((left + right) >> 1), String((top + bottom) >> 1));
  await pause(600);
}

async function capture(name) {
  const { stdout } = await exec('adb', ['-s', serial, 'exec-out', 'screencap', '-p'],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  await writeFile(path.join(output, `${name}.png`), stdout);
}

function position(tree) {
  return tree.filter(node => node.class === 'android.widget.TextView' && node.text)
    .map(node => [node.text, node.bounds]);
}

async function verify(name, density, short = false) {
  const initial = await nodes();
  const recovered = bounds(initial.find(node => node['resource-id'] === 'recovery'));
  const container = bounds(initial.find(node => node['resource-id'] === 'recovery-container'));
  const height = recovered[3] - recovered[1];
  if (short) assert.ok(height < 40 * density, 'Editing to one line releases the previous correction');
  else assert.ok(height >= 50 * density, 'Both native lines fit after recovery');
  assert.ok(container[3] - recovered[3] >= 15 * density, 'The parent grows and retains its bottom padding');
  const expected = position(initial);
  for (let sample = 0; sample < 4; sample++) {
    assert.deepEqual(position(await nodes()), expected, `${name}: refreshes must not move or resize text`);
  }
  await capture(name);
  return { name, height, positions: expected };
}

await mkdir(output, { recursive: true });
await prepareHierarchy({ adb, output });
const fontScale = (await adb('shell', 'settings', 'get', 'system', 'font_scale')).trim();
const focus = (await adb('shell', 'dumpsys', 'window')).match(/mCurrentFocus=.* u0 ([\w.$]+\/[\w.$]+)/)?.[1];
const density = Number([...(await adb('shell', 'wm', 'density')).matchAll(/density: (\d+)/g)].at(-1)?.[1]) / 160;
assert.ok(density > 0);
const report = { passed: false, cases: [] };
try {
  await adb('install', '-r', process.env.CHAT_TEXT_FLICKER_APK ?? path.join(root,
    '.codex-tmp/chat-text-flicker-build/outputs/apk/release/chat-text-flicker-fixture.apk'));
  for (const scale of [1, 1.3]) {
    await adb('shell', 'settings', 'put', 'system', 'font_scale', String(scale));
    await adb('shell', 'am', 'force-stop', applicationId);
    await adb('shell', 'am', 'start', '-W', '-n', `${applicationId}/com.codexswitch.mobile.MainActivity`);
    await pause(1500);
    report.cases.push(await verify(`android-light-wide-${scale}`, density));
    if (scale > 1) {
      // Bring the complete question into view, then confirm refreshes preserve the reader's position.
      await adb('shell', 'input', 'swipe', '540', '600', '540', '1400', '600');
      await pause(600);
      report.cases.push(await verify(`android-light-reading-${scale}`, density));
    }
    await tap('Width');
    report.cases.push(await verify(`android-light-narrow-${scale}`, density));
    await tap('Edit');
    report.cases.push(await verify(`android-light-edited-${scale}`, density, true));
    await tap('Edit');
    await tap('Width');
    await tap('Theme');
    report.cases.push(await verify(`android-dark-wide-${scale}`, density));
    await adb('shell', 'input', 'keyevent', '4');
    await adb('shell', 'am', 'start', '-W', '-n', `${applicationId}/com.codexswitch.mobile.MainActivity`);
    await pause(500);
    report.cases.push(await verify(`android-dark-return-${scale}`, density));
  }
  report.passed = true;
  console.log('PASS: corrected text and chat remain stable across refresh, widths, edits, themes and font scales');
} catch (error) {
  report.error = String(error);
  await capture('failure');
  throw error;
} finally {
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  await adb('shell', 'settings', 'put', 'system', 'font_scale', fontScale);
  await adb('shell', 'am', 'force-stop', applicationId);
  if (focus && !focus.startsWith(applicationId)) await adb('shell', 'am', 'start', '-W', '-n', focus);
}
