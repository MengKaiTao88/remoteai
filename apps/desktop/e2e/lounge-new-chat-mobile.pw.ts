import { expect, test } from '@playwright/test';
import { setupLounge } from './lounge-support';

const webURL = process.env.LOUNGE_TEST_WEB_URL ?? 'http://127.0.0.1:1486/web/';
test.setTimeout(120_000);

for (const width of [320, 390]) {
  test(`mobile new chat ${width}: exact lookup, recent speakers, errors and keyboard layout`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const relay = await setupLounge(page, true);
    await page.goto(webURL); await relay.ready();
    await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
    await page.locator('.discovery-lounge').click();
    const newChat = page.getByRole('button', { name: '新聊天', exact: true });
    await expect(newChat.locator('svg')).toHaveCount(1);
    await newChat.click();
    const sheet = page.getByRole('dialog');
    const input = sheet.getByRole('textbox', { name: '完整邮箱前缀或邮箱' });
    await expect(sheet.getByText('暂无最近发言用户，可输入邮箱查找。')).toBeVisible();
    await expect(input).not.toBeFocused();
    for (const [query, message] of [['bo', '未找到该用户'], ['shared', '多个用户使用此前缀'],
      ['alice@example.test', '这是你自己的账号']]) {
      await input.fill(query); await input.press('Enter');
      await expect(sheet.getByRole('alert')).toContainText(message);
    }
    await page.setViewportSize({ width, height: 420 });
    await input.fill('BOB');
    const start = sheet.getByRole('button', { name: '发起私聊', exact: true });
    await start.scrollIntoViewIfNeeded();
    const bounds = (await start.boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(420);
    await page.screenshot({ path: `../../.codex-tmp/new-chat-mobile-keyboard-${width}.png`, animations: 'disabled' });
    await start.click(); await expect(sheet).toBeHidden();
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('.lounge-heading h1')).toHaveText('bob');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('按邮箱发起私聊');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => relay.sent.map(frame => frame.to)).toEqual(['bob']);
    await page.getByRole('button', { name: '返回聊天列表' }).click();
    await newChat.click(); await input.fill('bob@EXAMPLE.test'); await input.press('Enter');
    await expect(sheet).toBeHidden();
    await page.getByRole('button', { name: '返回聊天列表' }).click();
    relay.push('最近发言用户');
    await newChat.click();
    await expect(sheet.getByRole('button', { name: '与 bob 私聊' })).toBeVisible();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(sheet).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `../../.codex-tmp/new-chat-mobile-recent-${width}.png`, animations: 'disabled' });
    const count = relay.lookups.length;
    await sheet.getByRole('button', { name: '与 bob 私聊' }).click();
    await expect(sheet).toBeHidden(); expect(relay.lookups).toHaveLength(count);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`mobile new chat ${width}: cancelling a lookup preserves drafts and member navigation`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const relay = await setupLounge(page, true);
    await page.goto(webURL); await relay.ready(); relay.push('群聊发言');
    await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
    await page.locator('.discovery-lounge').click();
    await page.getByRole('button', { name: '群聊', exact: true }).click();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('保留群聊草稿');
    await page.getByRole('button', { name: '成员', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: '查看 bob 的资料' })).toBeVisible();
    await page.locator('.ant-drawer-close:visible').click();
    await page.getByRole('button', { name: '返回聊天列表' }).click();
    await page.getByRole('button', { name: '新聊天', exact: true }).click();
    relay.lookupReply(false);
    await page.getByRole('dialog').getByRole('textbox').fill('bob');
    await page.getByRole('dialog').getByRole('button', { name: '发起私聊' }).click();
    await page.locator('.ant-drawer-close:visible').click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.getByRole('button', { name: '群聊', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('保留群聊草稿');
  });
}
