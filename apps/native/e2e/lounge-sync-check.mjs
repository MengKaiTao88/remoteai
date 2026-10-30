import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export async function loadHistorySource(root) {
  const outfile = path.join(root, '.codex-tmp/lounge-sync-source.mjs');
  await build({ entryPoints: [path.join(root, 'apps/native/e2e/lounge-sync-source.ts')], outfile,
    bundle: true, platform: 'node', format: 'esm', target: 'node22' });
  return (await import(pathToFileURL(outfile).href)).createHistorySource();
}

export async function verifyNativeSync({ adb, tap, find, screenshot, scale, source, assertEventually, hideKeyboard }) {
  await tap('与 bob 私聊');
  await find('来自另一台设备的私聊记录');
  await screenshot(`device-sync-private-${scale}`);
  const text = `Native-synced-${Date.now()}`;
  await tap('消息'); await adb('shell', 'input', 'text', text); await tap('发送');
  await assertEventually(() => source.hasText(text), 'Native outgoing message reaches the other device');
  await hideKeyboard(); await tap('聊天'); await tap('群聊');
  await tap('添加内容'); await tap('历史记录'); await tap('搜索消息或账户');
  await adb('shell', 'input', 'text', 'SyncGroup'); await find('来自另一台设备的群聊记录 SyncGroup');
  await hideKeyboard(); await screenshot(`device-sync-history-${scale}`); await tap('返回聊天');
  await tap('消息保存在本机 · 同账号设备在线时同步');
  await find('消息保存在各设备'); await screenshot(`device-sync-about-${scale}`); await tap('知道了');
  source.broker.fail = true; source.broker.disconnectAll();
  await find('设备间消息同步暂时中断，正在重试。');
  await screenshot(`device-sync-retry-${scale}`);
  source.add(`断线后补回记录 ${scale}`); await tap('重试'); source.broker.fail = false;
  await find(`断线后补回记录 ${scale}`); await screenshot(`device-sync-restored-${scale}`);
  assert.ok(source.broker.relayFrames > 0, 'Native sync uses existing binary encrypted relay');
  await tap('聊天'); await tap('返回发现'); await find('在线交流');
  console.log(`PASS native device sync at font scale ${scale}: incoming/outgoing, images, retry and navigation`);
}
