import { expect, test } from '@playwright/test';
import { setupLounge, pixel } from './lounge-support';
import type {} from './lounge-harness';

for (const width of [320, 390]) {
  test(`mobile chat previews ${width}: latest unread text remains after reading without selection`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const relay = await setupLounge(page, true);
    await page.goto('http://127.0.0.1:1486/web/'); await relay.ready();
    await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
    await page.locator('.discovery-lounge').click();
    relay.private('较早的未读消息');
    const latest = '最新未读消息的文字部分\n很长的文字需要单行显示，超过可用宽度后使用省略号。';
    relay.private(latest);
    const privateChat = page.getByRole('button', { name: '与 bob 私聊', exact: true });
    const preview = privateChat.locator('.lounge-chat-row-copy > span');
    await expect(preview).toHaveText(latest.replace('\n', ' '));
    await expect(page.locator('.lounge-chat-row').filter({ has: privateChat })
      .locator('.lounge-avatar-unread')).toHaveText('2');
    await expect(preview).toHaveCSS('white-space', 'nowrap');
    await expect(preview).toHaveCSS('text-overflow', 'ellipsis');
    expect(await preview.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    await expect(page.locator('.lounge-chat-rows [aria-current]')).toHaveCount(0);
    await expect(page.getByText('当前', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `../../.codex-tmp/lounge-preview-unread-${width}.png` });
    await privateChat.click();
    await expect(page.getByText(latest, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回聊天列表', exact: true }).click();
    await expect(preview).toHaveText(latest.replace('\n', ' '));
    await expect(page.locator('.lounge-chat-row').filter({ has: privateChat })
      .locator('.lounge-avatar-unread')).toHaveCount(0);
    await expect(page.locator('.lounge-chat-row.is-current')).toHaveCount(0);
    await expect(page.locator('.lounge-chat-row').last()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: `../../.codex-tmp/lounge-preview-read-${width}.png` });
    await privateChat.click();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('我的回复');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('button', { name: '返回聊天列表', exact: true }).click();
    await expect(preview).toHaveText('我的回复');
    await page.getByRole('button', { name: '群聊', exact: true }).click();
    await page.getByRole('button', { name: '返回聊天列表', exact: true }).click();
    await expect(page.locator('.lounge-chat-row.is-current, .lounge-chat-rows [aria-current]')).toHaveCount(0);
  });
}

for (const width of [320, 390]) {
  for (const theme of ['light', 'dark']) {
    test(`mobile redesign ${width} ${theme}: empty, sheets, compact composer and navigation`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const relay = await setupLounge(page, true);
      await page.goto('http://127.0.0.1:1486/web/'); await relay.ready();
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
      await page.locator('.discovery-lounge').click();
      await page.getByRole('button', { name: '群聊', exact: true }).click();
      const header = page.locator('.lounge-mobile-heading');
      const composer = page.locator('.lounge-composer');
      await expect(header).toBeVisible();
      expect((await header.boundingBox())!.height).toBeLessThan(95);
      expect((await composer.boundingBox())!.height).toBeLessThan(95);
      await expect(page.getByText('已连接', { exact: true })).toBeHidden();
      await page.screenshot({ path: `../../.codex-tmp/lounge-redesign-${width}-${theme}.png` });
      await page.getByRole('button', { name: '大家好呀 👋' }).click();
      const input = page.getByRole('textbox', { name: '消息', exact: true });
      await expect(input).toHaveValue('大家好呀 👋'); expect(relay.sent).toHaveLength(0);
      await page.getByRole('button', { name: '聊天', exact: true }).click();
      await expect(page.locator('.lounge-chat-row')).toContainText('[草稿] 大家好呀 👋');
      await page.getByRole('textbox', { name: '搜索聊天' }).fill('does-not-exist');
      await expect(page.getByText('没有找到相关聊天')).toBeVisible();
      await page.getByRole('textbox', { name: '搜索聊天' }).fill('');
      await page.getByRole('button', { name: '群聊', exact: true }).click();
      await expect(input).toHaveValue('大家好呀 👋');
      await expect(page.locator('.lounge-retention')).toHaveCount(0);
      await page.getByRole('button', { name: '添加内容', exact: true }).click();
      await page.getByRole('button', { name: '关于聊天', exact: true }).click();
      await expect(page.getByText('服务器不保存聊天内容')).toBeVisible();
      await page.getByRole('button', { name: '知道了' }).click();
      await page.getByRole('button', { name: '添加内容', exact: true }).click();
      await expect(page.getByRole('button', { name: '添加图片', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '历史记录', exact: true })).toBeVisible();
      await page.locator('.ant-drawer-close:visible').click();
      await input.fill('第一行\n第二行\n第三行');
      expect((await input.boundingBox())!.height).toBeGreaterThan(44);
      await page.setViewportSize({ width, height: 450 });
      await expect.poll(async () => {
        const send = await page.getByRole('button', { name: '发送', exact: true }).boundingBox();
        return send!.y + send!.height;
      }).toBeLessThanOrEqual(450);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('button', { name: '返回聊天列表' }).click();
      await page.getByRole('button', { name: '返回发现' }).click();
      await expect(page.locator('.discovery-lounge')).toBeVisible();
    });
  }
}

test('mobile redesign: members, drafts, unread and scroll survive conversation switching', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = await setupLounge(page, true);
  await page.goto('http://127.0.0.1:1486/web/'); await relay.ready();
  await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
  await page.locator('.discovery-lounge').click();
  await page.getByRole('button', { name: '群聊', exact: true }).click();
  for (let index = 0; index < 30; index++) relay.push(`group-${index}`);
  await expect(page.locator('.lounge-message')).toHaveCount(30);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('群聊草稿');
  await page.locator('.lounge-composer input[type=file]').setInputFiles({ name: 'image.png', mimeType: 'image/png',
    buffer: Buffer.from(pixel.split(',')[1], 'base64') });
  await expect(page.locator('.lounge-attachments img')).toHaveCount(1);
  await page.locator('.lounge-conversation').evaluate(node => { node.scrollTop = 80; });
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible();
  const previousOffset = await page.locator('.lounge-conversation').evaluate(node => node.scrollTop);
  await page.getByRole('button', { name: '成员', exact: true }).click();
  await page.locator('.lounge-mobile-sheet').getByRole('button', { name: '查看 bob 的资料', exact: true }).click();
  await page.getByRole('button', { name: '发消息', exact: true }).click();
  await expect(input).toHaveValue('');
  await input.fill('私聊草稿');
  relay.push('unread-group');
  const incoming = relay.private('private-while-list', { id: 'carol', account: 'carol@example.test' });
  await page.getByRole('button', { name: /^聊天/ }).click();
  const carol = page.getByRole('button', { name: '与 carol 私聊', exact: true });
  await expect(page.locator('.lounge-chat-row').filter({ has: carol })
    .locator('.lounge-avatar-unread')).toHaveText('1');
  expect(relay.receipts.some(receipt => receipt.id === incoming && receipt.status === 'read')).toBe(false);
  await page.getByRole('button', { name: '群聊', exact: true }).click();
  await expect(input).toHaveValue('群聊草稿');
  await expect(page.locator('.lounge-attachments img')).toHaveCount(1);
  // New group content increases distance from the bottom, while preserving the previous viewport.
  await expect.poll(async () => {
    const offset = await page.locator('.lounge-conversation').evaluate(node => node.scrollTop);
    return offset > 0 ? Math.abs(offset - previousOffset) : Number.POSITIVE_INFINITY;
  }).toBeLessThan(180);
  await page.getByRole('button', { name: /^聊天/ }).click(); await carol.click();
  await expect(page.getByText('private-while-list', { exact: true })).toBeVisible();
  await expect.poll(() => relay.receipts.some(receipt => receipt.id === incoming && receipt.status === 'read')).toBe(true);
  await page.getByRole('button', { name: '聊天', exact: true }).click();
  await page.getByRole('button', { name: '与 bob 私聊', exact: true }).click();
  await expect(input).toHaveValue('私聊草稿');
  await page.screenshot({ path: '../../.codex-tmp/lounge-redesign-private.png' });
});

test('mobile redesign: all released languages switch offline without losing a draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = await setupLounge(page);
  await page.goto('/e2e/lounge-harness.html?mobile&dark'); await relay.ready();
  await page.getByRole('button', { name: '在线交流', exact: true }).click();
  await page.getByRole('button', { name: '群聊', exact: true }).click();
  await page.locator('.lounge-composer textarea').fill('unsent multilingual draft');
  await page.context().setOffline(true);
  for (const language of ['en', 'ja', 'ru', 'zh'] as const) {
    await page.evaluate(value => window.loungeFixture.setLanguage(value), language);
    await expect(page.locator('.lounge-composer textarea')).toHaveValue('unsent multilingual draft');
    await expect(page.locator('.lounge-mobile')).not.toContainText('client.lounge.');
    await page.locator('.lounge-chats-trigger').click();
    await expect(page.locator('.lounge-chat-row')).toContainText('unsent multilingual draft');
    await expect(page.locator('.lounge-chat-list')).not.toContainText('client.lounge.');
    await page.locator('.lounge-chat-row').first().click();
    await page.locator('.lounge-more').click();
    await page.locator('.lounge-about-trigger').click();
    await expect(page.locator('.lounge-mobile-sheet')).not.toContainText('client.lounge.');
    await page.screenshot({ path: `../../.codex-tmp/lounge-mobile-language-${language}.png` });
    await page.locator('.lounge-sheet-done').click();
  }
});
