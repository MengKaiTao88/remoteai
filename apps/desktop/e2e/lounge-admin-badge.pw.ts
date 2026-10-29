import { expect, test, type Page } from '@playwright/test';
import { setupLounge } from './lounge-support';
import { openLoungeAction } from './lounge-mobile-actions';
import type {} from './lounge-harness';

async function enter(page: Page, mobile: boolean) {
  if (!mobile) return page.getByRole('button', { name: '在线交流', exact: true }).click();
  await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
  await page.locator('.discovery-lounge').click();
  await page.getByRole('button', { name: '群聊', exact: true }).click();
}

for (const mode of ['local', 'remote', 'web', 'mobile-320', 'mobile-390']) {
  test(`${mode}: administrator identity, own messages and offline history`, async ({ page }) => {
    const mobile = mode.startsWith('mobile');
    const web = mobile || mode === 'web';
    if (mobile) await page.setViewportSize({ width: Number(mode.split('-')[1]), height: 844 });
    const relay = await setupLounge(page, web);
    await page.goto(web ? 'http://127.0.0.1:1486/web/' : `/e2e/lounge-harness.html?mode=${mode}`);
    await relay.ready(); await enter(page, mobile);
    relay.push('普通成员消息');
    relay.frame({ type: 'message', id: 'manager-message', text: '管理员消息', images: [],
      sender: { id: 'manager', account: 'manager@example.test', moderator: true, nickname: '聊天管理员' },
      sentAt: new Date().toISOString() });
    const manager = page.locator('.lounge-message').filter({ has: page.getByText('管理员消息', { exact: true }) });
    await expect(manager.locator('.lounge-moderator-badge')).toHaveText('管理员');
    await expect(page.locator('.lounge-message').filter({ hasText: '普通成员消息' })
      .locator('.lounge-moderator-badge')).toHaveCount(0);
    expect(await manager.locator('.lounge-sender').evaluate(node => {
      const badge = node.firstElementChild!.getBoundingClientRect();
      const name = node.lastElementChild!.getBoundingClientRect();
      return badge.right <= name.left && badge.top < name.bottom;
    })).toBe(true);
    relay.policy(true); relay.groupReply('manual');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('自己发送的管理员消息');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => relay.sent.length).toBe(1); relay.acceptGroup(0);
    await expect(page.locator('.lounge-message.is-own .lounge-moderator-badge')).toHaveText('管理员');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      await expect(manager.locator('.lounge-moderator-badge')).toHaveCSS('background-color', 'rgb(250, 204, 21)');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `../../.codex-tmp/lounge-admin-${mode}-${theme}.png` });
    }
    relay.policy(false);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('撤销管理员后的消息');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => relay.sent.length).toBe(2); relay.acceptGroup(1);
    await expect(page.locator('.lounge-message').filter({ hasText: '撤销管理员后的消息' })
      .locator('.lounge-moderator-badge')).toHaveCount(0);
    await openLoungeAction(page, '历史记录');
    const history = page.locator('.lounge-history-message').filter({ hasText: '管理员消息' }).first();
    await expect(history.locator('.lounge-moderator-badge')).toHaveText('管理员');
    await page.locator('.ant-drawer-close').click();
    relay.offline(); await page.evaluate(() => sessionStorage.setItem('lounge-test-offline', '1'));
    await page.reload(); await enter(page, mobile);
    await expect(page.locator('.lounge-message').filter({ hasText: '管理员消息' }).first()
      .locator('.lounge-moderator-badge')).toHaveText('管理员');
    if (!web) for (const [language, label] of [['en', 'Admin'], ['ja', '管理者'], ['ru', 'Админ'], ['zh', '管理员']] as const) {
      await page.evaluate(value => window.loungeFixture.setLanguage(value), language);
      await expect(page.locator('.lounge-moderator-badge').first()).toHaveText(label);
    }
  });
}
