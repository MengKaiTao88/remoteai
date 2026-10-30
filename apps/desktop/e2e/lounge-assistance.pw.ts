import { expect, test, type Locator, type Page } from '@playwright/test';
import { setupLounge } from './lounge-support';
import { setupAssistance } from './lounge-assistance-support';
import type {} from './lounge-harness';

test.setTimeout(120_000);
test.use({ actionTimeout: 10_000 });

const confirmation = (page: Page) => page.locator('.lounge-assistance-confirm:visible');
const invitationDialog = (page: Page) => page.getByRole('dialog', { name: '远程协助', exact: true });
const webURL = process.env.LOUNGE_TEST_WEB_URL ?? 'http://127.0.0.1:1486/web/';

async function screenshotConfirmation(page: Page, name: string) {
  await confirmation(page).getByRole('button', { name: '发送邀请' }).hover();
  await page.screenshot({ path: `../../.codex-tmp/lounge-assistance-${name}.png`, animations: 'disabled' });
}

async function longPress(avatar: Locator) {
  const box = (await avatar.boundingBox())!;
  const pointer = { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0,
    clientX: box.x + 15, clientY: box.y + 15 };
  await avatar.dispatchEvent('pointerdown', pointer);
  await expect(avatar.page().getByRole('menuitem', { name: '远程协助' })).toBeVisible();
  await avatar.dispatchEvent('pointerup', pointer);
}

for (const mode of ['local', 'remote', 'web']) {
  test(`${mode}: assistance entries, confirmation, right-click and long-press`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const relay = await setupLounge(page, mode === 'web');
    if (mode !== 'web') await setupAssistance(page);
    await page.goto(mode === 'web' ? webURL
      : `/e2e/lounge-harness.html?mode=${mode}&assistance`);
    await relay.ready();
    await page.getByRole('button', { name: '在线交流', exact: true }).click();
    await page.locator('.lounge-heading').getByRole('button', { name: '远程协助' }).click();
    const dialog = invitationDialog(page);
    await expect(dialog).toBeVisible();
    if (mode === 'web') {
      await expect(dialog).toContainText('请在需要协助的电脑上打开 Remote AI');
      await dialog.getByRole('button', { name: '知道了' }).click();
    } else {
      await dialog.getByRole('textbox', { name: '对方的登录邮箱' }).fill(' helper@example.test ');
      expect(await page.evaluate(() => window.loungeAssistanceFixture.invited)).toEqual([]);
      await dialog.getByRole('button', { name: '发送邀请' }).click();
      await expect.poll(() => page.evaluate(() => window.loungeAssistanceFixture.invited))
        .toEqual(['helper@example.test']);
      await dialog.getByRole('button', { name: '取消邀请' }).click();
      await dialog.getByRole('button', { name: 'Close' }).click();
    }
    relay.push('远程协助头像菜单');
    const avatar = page.locator('.lounge-conversation .lounge-avatar').first();
    await avatar.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: '@该用户' })).toBeVisible();
    await page.getByRole('menuitem', { name: '远程协助' }).click();
    await expect(confirmation(page)).toContainText('向 bob 请求远程协助？');
    await expect(confirmation(page)).toContainText('邀请对方查看并操作本机');
    expect((await confirmation(page).boundingBox())!.width).toBeLessThanOrEqual(400);
    await screenshotConfirmation(page, `${mode}-avatar`);
    await confirmation(page).getByRole('button', { name: /^取\s*消$/ }).click();
    await expect(dialog).toBeHidden();
    await longPress(avatar);
    await page.getByRole('menuitem', { name: '远程协助' }).click();
    await expect(confirmation(page)).toContainText('bob');
    await page.locator('.lounge-heading h1').click();
    await expect(confirmation(page)).toBeHidden();
    await avatar.click();
    const toolbar = page.locator('.lounge-toolbar');
    const assist = toolbar.getByRole('button', { name: '远程协助' });
    const history = toolbar.getByRole('button', { name: '历史记录' });
    const assistBox = (await assist.boundingBox())!, historyBox = (await history.boundingBox())!;
    expect(assistBox.x).toBeLessThan(historyBox.x);
    expect(Math.abs(assistBox.y - historyBox.y)).toBeLessThanOrEqual(3);
    await assist.click();
    await expect(confirmation(page)).toContainText('bob');
    await screenshotConfirmation(page, `${mode}-direct`);
    await confirmation(page).getByRole('button', { name: '发送邀请' }).click();
    await expect(dialog).toBeVisible();
    if (mode === 'web') {
      await expect(dialog).toContainText('对方账号：bob');
      await expect(dialog).toContainText('请在需要协助的电脑上打开 Remote AI');
    } else {
      await expect.poll(() => page.evaluate(() => window.loungeAssistanceFixture.invited))
        .toEqual(['helper@example.test', 'bob']);
      await expect(dialog.getByRole('button', { name: '取消邀请' })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('confirmed avatar invitation preserves the recipient when desktop permissions are missing', async ({ page }) => {
  const relay = await setupLounge(page);
  await setupAssistance(page);
  await page.goto('/e2e/lounge-harness.html?assistance'); await relay.ready();
  await page.evaluate(() => { window.loungeAssistanceFixture.permissions = false; });
  await page.getByRole('button', { name: '在线交流', exact: true }).click();
  relay.push('请求协助');
  await page.locator('.lounge-conversation .lounge-avatar').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '远程协助' }).click();
  await confirmation(page).getByRole('button', { name: '发送邀请' }).click();
  const dialog = invitationDialog(page);
  await expect(dialog).toContainText('请先在设置中允许远程桌面和键鼠控制');
  await expect(dialog).toContainText('对方账号：bob');
  await expect(dialog.getByRole('textbox', { name: '对方的登录邮箱' })).toHaveCount(0);
  expect(await page.evaluate(() => window.loungeAssistanceFixture.invited)).toEqual([]);
  await page.evaluate(() => { window.loungeAssistanceFixture.permissions = true; });
  await dialog.getByRole('button', { name: '发送邀请' }).click();
  await expect.poll(() => page.evaluate(() => window.loungeAssistanceFixture.invited)).toEqual(['bob']);
});

test('assistance confirmation follows language changes with offline resources and a narrow dark layout', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const relay = await setupLounge(page);
  await setupAssistance(page);
  await page.goto('/e2e/lounge-harness.html?assistance&dark'); await relay.ready();
  await page.getByRole('button', { name: '在线交流', exact: true }).click();
  relay.push('切换语言');
  await page.locator('.lounge-conversation .lounge-avatar').first().click();
  await page.locator('.lounge-toolbar').getByRole('button', { name: '远程协助' }).click();
  const translations = [
    ['en', 'Ask bob for remote assistance?'],
    ['ja', 'bob にリモートアシスタンスを依頼しますか？'],
    ['ru', 'Попросить bob об удалённой помощи?'],
    ['zh', '向 bob 请求远程协助？'],
  ] as const;
  await page.context().setOffline(true);
  for (const [language, title] of translations) {
    await page.evaluate(language => window.loungeFixture.setLanguage(language), language);
    await expect(confirmation(page)).toContainText(title);
    const bounds = (await confirmation(page).boundingBox())!;
    expect(bounds.width).toBeLessThanOrEqual(400);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(900);
  }
  await screenshotConfirmation(page, 'dark-languages');
  expect(await page.evaluate(() => window.loungeAssistanceFixture.invited)).toEqual([]);
});
