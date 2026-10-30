import { expect, test } from '@playwright/test';
import { pixel, setupLounge } from './lounge-support';

for (const width of [320, 390]) for (const theme of ['light', 'dark']) {
  test(`mobile chat list ${width} ${theme}: presence and discovery re-entry`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const relay = await setupLounge(page, true);
    await page.goto('http://127.0.0.1:1486/web/'); await relay.ready();
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
    await page.locator('.discovery-lounge').click();
    await expect(page.getByRole('textbox', { name: '搜索聊天' })).toBeVisible();
    await expect(page.locator('.lounge-composer')).toHaveCount(0);
    const id = relay.private('Unread private message');
    const bob = page.getByRole('button', { name: '与 bob 私聊', exact: true });
    const row = page.locator('.lounge-chat-row').filter({ has: bob });
    const dot = row.locator('.lounge-avatar-presence');
    const green = 'rgb(34, 197, 94)';
    const red = 'rgb(239, 68, 68)';
    await expect(dot).toHaveCSS('background-color', green);
    await expect(row.locator('.lounge-avatar-unread')).toHaveText('1');
    expect(relay.receipts.some(receipt => receipt.id === id && receipt.status === 'read')).toBe(false);
    await expect(page.getByRole('button', { name: '群聊', exact: true })
      .locator('.lounge-avatar-presence')).toHaveCount(0);
    const avatar = (await row.locator('.lounge-avatar').boundingBox())!;
    const badge = (await dot.boundingBox())!;
    expect(badge.x + badge.width).toBeCloseTo(avatar.x + avatar.width, 0);
    expect(badge.y + badge.height).toBeCloseTo(avatar.y + avatar.height, 0);
    await page.screenshot({ path: `../../.codex-tmp/lounge-presence-${width}-${theme}-online.png` });
    relay.contact(false);
    await expect(dot).toHaveCSS('background-color', red);
    await expect(bob).toHaveAccessibleDescription('离线');
    await page.screenshot({ path: `../../.codex-tmp/lounge-presence-${width}-${theme}-offline.png` });
    relay.contact(null);
    await expect(dot).toHaveCSS('background-color', red);
    await expect(bob).toHaveAccessibleDescription('在线状态不可见');
    relay.private('Picture avatar', { id: 'bob', account: 'bob@example.test', avatar: pixel });
    await expect(row.locator('img')).toBeVisible();
    relay.contact(true); await expect(dot).toHaveCSS('background-color', green);
    await page.screenshot({ path: `../../.codex-tmp/lounge-presence-${width}-${theme}-avatar.png` });
    await bob.click();
    await expect(page.locator('.lounge-composer')).toBeVisible();
    await expect.poll(() => relay.receipts.some(receipt => receipt.id === id && receipt.status === 'read')).toBe(true);
    await page.getByRole('button', { name: '返回聊天列表' }).click();
    await page.getByRole('button', { name: '返回发现' }).click();
    await page.locator('.discovery-lounge').click();
    await expect(bob).toBeVisible();
    await expect(page.locator('.lounge-composer')).toHaveCount(0);
    await page.getByRole('button', { name: '群聊', exact: true }).click();
    await page.getByRole('button', { name: '返回聊天列表' }).click();
    await page.getByRole('button', { name: '返回发现' }).click();
    await page.locator('.discovery-lounge').click();
    await expect(page.getByRole('textbox', { name: '搜索聊天' })).toBeVisible();
    relay.offline(); relay.close();
    await expect(dot).toHaveCSS('background-color', red);
  });
}
