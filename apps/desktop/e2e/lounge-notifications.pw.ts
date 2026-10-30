import { expect, test, type Locator, type Page } from '@playwright/test';
import { setupLounge } from './lounge-support';

async function openMenu(row: Locator, touch: boolean) {
  await expect(row.page().getByRole('menuitem', { name: /免打扰/ })).toHaveCount(0);
  if (!touch) { await row.click({ button: 'right' }); return; }
  const box = (await row.boundingBox())!;
  const pointer = { pointerId: 7, pointerType: 'touch', button: 0, isPrimary: true,
    clientX: box.x + 20, clientY: box.y + 20 };
  await row.dispatchEvent('pointerdown', pointer);
  await expect(row.page().getByRole('menuitem', { name: /免打扰/ })).toBeVisible();
  await row.dispatchEvent('pointerup', pointer);
}

async function enter(page: Page, mobile: boolean) {
  if (mobile) {
    await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
    await page.locator('.discovery-lounge').click();
  } else await page.getByRole('button', { name: '在线交流', exact: true }).click();
}

for (const mode of ['local', 'remote', 'web', 'mobile-320', 'mobile-390']) {
  test(`${mode}: mute group/private entry badges, retain avatar counts and recover failures`, async ({ page }) => {
    test.setTimeout(90_000);
    const mobile = mode.startsWith('mobile'); const web = mode === 'web' || mobile;
    await page.setViewportSize({ width: mobile ? Number(mode.split('-')[1]) : 1280, height: 900 });
    const relay = await setupLounge(page, web);
    await page.goto(web ? 'http://127.0.0.1:1486/web/' : `/e2e/lounge-harness.html?mode=${mode}`);
    await relay.ready(); await enter(page, mobile);
    relay.private('read this chat', { id: 'carol', account: 'carol@example.test' });
    await page.getByRole('button', { name: '与 carol 私聊', exact: true }).click();
    if (mobile) await page.getByRole('button', { name: '返回聊天列表', exact: true }).click();
    for (let index = 0; index < 100; index++) { relay.push(`group-${index}`); relay.private(`private-${index}`); }
    const group = page.locator('.lounge-person, .lounge-chat-row').filter({ hasText: '群聊' }).filter({ visible: true });
    const bob = page.locator('.lounge-person, .lounge-chat-row').filter({ hasText: 'bob' })
      .filter({ visible: true });
    await expect(group.locator('.lounge-avatar-unread')).toHaveText('99+');
    // Direct receipts serialize IndexedDB writes before publishing the next message.
    await expect(bob.locator('.lounge-avatar-unread')).toHaveText('99+', { timeout: 20_000 });
    const avatar = (await bob.locator('.lounge-avatar').boundingBox())!;
    const badge = (await bob.locator('.lounge-avatar-unread').boundingBox())!;
    expect(badge.y).toBeLessThan(avatar.y);
    expect(badge.x + badge.width / 2).toBeGreaterThan(avatar.x + avatar.width / 2);
    await openMenu(group, false); await page.getByRole('menuitem', { name: '消息免打扰', exact: true }).click();
    await expect.poll(() => relay.notifications.muted).toContain('');
    await openMenu(bob, true); await page.getByRole('menuitem', { name: '消息免打扰', exact: true }).click();
    await expect.poll(() => relay.notifications.muted).toContain('bob');
    await expect(page.locator('.lounge-nav-badge')).toHaveCount(0);
    await expect(group.locator('.lounge-avatar-unread')).toHaveText('99+');
    await expect(bob.locator('.lounge-avatar-unread')).toHaveText('99+');
    await expect(page.getByRole('menuitem', { name: /免打扰/ })).toHaveCount(0);
    await page.screenshot({ path: `../../.codex-tmp/lounge-notifications-${mode}.png` });
    relay.notifications.fail = true;
    await openMenu(group, true); await page.getByRole('menuitem', { name: '取消免打扰', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('未能保存免打扰设置');
    await expect(page.locator('.lounge-nav-badge')).toHaveCount(0);
    relay.notifications.fail = false;
    await openMenu(group, false); await page.getByRole('menuitem', { name: '取消免打扰', exact: true }).click();
    await expect.poll(() => relay.notifications.muted).not.toContain('');
    await expect(group.locator('[aria-label="已开启免打扰"]')).toHaveCount(0);
    await expect(group.locator('.lounge-avatar-unread')).toHaveText('99+');
    if (!mobile) await expect(page.locator('.lounge-nav-badge')).toHaveText('99+');
    await page.reload(); await relay.ready(); await enter(page, mobile);
    await expect(bob.locator('[aria-label="已开启免打扰"]')).toBeVisible();
  });
}

test('another terminal receives changes live and restores them after reconnecting', async ({ browser }) => {
  const firstContext = await browser.newContext(); const secondContext = await browser.newContext();
  try {
    const first = await firstContext.newPage(); const second = await secondContext.newPage();
    const sender = await setupLounge(first); const receiver = await setupLounge(second, true);
    sender.notifications.shareWith(receiver.notifications);
    await first.goto('/e2e/lounge-harness.html'); await second.goto('http://127.0.0.1:1486/web/');
    await sender.ready(); await receiver.ready(); await enter(first, false);
    receiver.push('unread on another device');
    await expect(second.locator('.lounge-nav-badge')).toHaveText('1');
    await first.locator('.lounge-person').filter({ hasText: '群聊' }).click({ button: 'right' });
    await first.getByRole('menuitem', { name: '消息免打扰', exact: true }).click();
    await expect(second.locator('.lounge-nav-badge')).toHaveCount(0);
    await second.reload(); await expect.poll(receiver.count).toBe(2);
    receiver.push('muted after reconnect');
    await expect(second.locator('.lounge-nav-badge')).toHaveCount(0);
    await first.locator('.lounge-person').filter({ hasText: '群聊' }).click({ button: 'right' });
    await first.getByRole('menuitem', { name: '取消免打扰', exact: true }).click();
    await expect(second.locator('.lounge-nav-badge')).toHaveText('1');
  } finally { await firstContext.close(); await secondContext.close(); }
});
