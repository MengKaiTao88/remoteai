import { openLoungeAction } from './lounge-mobile-actions';
import { expect, test, type Locator } from '@playwright/test';
import { setupLounge, pixel } from './lounge-support';
import { expectNoMenuOutsideBubble } from './lounge-gestures';

async function aligned(message: Locator, own: boolean) {
  const bounds = await message.evaluate(element => {
    const main = element.querySelector('.lounge-message-main')!.getBoundingClientRect();
    const bubble = element.querySelector('.lounge-bubble')!;
    const style = getComputedStyle(bubble);
    return { left: main.left + parseFloat(style.paddingLeft), right: main.right - parseFloat(style.paddingRight),
      images: [...element.querySelectorAll('.lounge-image img')].map(image => {
        const { left, right, width, height } = image.getBoundingClientRect(); return { left, right, width, height };
      }) };
  });
  for (const image of bounds.images) {
    expect(Math.abs(own ? image.right - bounds.right : image.left - bounds.left)).toBeLessThanOrEqual(1);
    expect(image.width).toBeLessThanOrEqual(320); expect(image.height).toBeLessThanOrEqual(280);
  }
}

for (const mode of ['local', 'remote', 'web', 'mobile']) {
  test(`${mode}: image edges, context gestures, quoted replies and privileged presence`, async ({ page }) => {
    if (mode === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
    const web = mode === 'web' || mode === 'mobile';
    const relay = await setupLounge(page, web);
    await page.goto(web ? 'http://127.0.0.1:1486/web/' : `/e2e/lounge-harness.html?mode=${mode}`);
    await relay.ready();
    if (mode === 'mobile') {
      await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
      await page.locator('.discovery-lounge').click();
      await page.getByRole('button', { name: '群聊', exact: true }).click();
    } else await page.getByRole('button', { name: '在线交流', exact: true }).click();
    const pictures = await page.evaluate(() => [[800, 300], [300, 900]].map(([width, height]) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const drawing = canvas.getContext('2d')!; drawing.fillStyle = '#30b2a4'; drawing.fillRect(0, 0, width, height);
      return canvas.toDataURL('image/png');
    }));
    for (const source of pictures) relay.push('', [source]);
    const rows = page.locator('.lounge-message'); await expect(rows).toHaveCount(2);
    await expect.poll(() => rows.first().locator('img').evaluate((image: HTMLImageElement) => image.complete)).toBe(true);
    await aligned(rows.nth(0), false); await aligned(rows.nth(1), false);
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    for (const [index, source] of pictures.entries()) {
      await page.locator('.lounge-composer input[type=file]').setInputFiles({ name: `photo-${index}.png`,
        mimeType: 'image/png', buffer: Buffer.from(source.split(',')[1], 'base64') });
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect(input).toHaveValue('');
      await expect(page.locator('.lounge-message.is-own')).toHaveCount(index + 1);
      await aligned(page.locator('.lounge-message.is-own').nth(index), true);
    }
    relay.push('quoted-original', [pixel]);
    const original = rows.filter({ hasText: 'quoted-original' });
    await expectNoMenuOutsideBubble(page, original);
    const bubble = original.locator('.lounge-bubble');
    await bubble.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: '发起私聊' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '屏蔽此人' })).toBeVisible();
    await page.getByRole('menuitem', { name: '引用回复' }).click();
    await expect(page.locator('.lounge-reply-draft')).toContainText('quoted-original');
    await input.fill('keep draft');
    await page.getByRole('button', { name: '取消引用' }).click();
    await expect(input).toHaveValue('keep draft');
    await expect(page.getByRole('menuitem', { name: '引用回复' })).toBeHidden();
    const originalBounds = (await bubble.boundingBox())!;
    await bubble.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0,
      isPrimary: true, clientX: originalBounds.x + 10, clientY: originalBounds.y + 10 });
    await expect(page.getByRole('menuitem', { name: '发起私聊' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '屏蔽此人' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '引用回复' })).toBeVisible();
    await bubble.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', isPrimary: true });
    await page.getByRole('menuitem', { name: '引用回复' }).click();
    await input.fill('reply-text');
    await expect(page.getByRole('menuitem', { name: '引用回复' })).toBeHidden();
    await page.locator('.lounge-composer input[type=file]').setInputFiles({ name: 'reply-image.png',
      mimeType: 'image/png', buffer: Buffer.from(pixel.split(',')[1], 'base64') });
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.lounge-reply-draft')).toHaveCount(0);
    expect(relay.sent.at(-1)?.reply).toMatchObject({ account: 'bob', text: 'quoted-original', imageCount: 1 });
    const response = rows.filter({ hasText: 'reply-text' });
    await expect(response.locator('.lounge-reply')).toContainText('quoted-original');
    await aligned(response, true);
    await expectNoMenuOutsideBubble(page, response);
    relay.presence(99); await expect(page.locator('.lounge-online-count')).toHaveCount(0);
    relay.policy(true); await expect(page.locator('.lounge-online-count')).toHaveText(mode === 'mobile' ? '2 人在线' : '在线 2 人');
    relay.presence(3); await expect(page.locator('.lounge-online-count')).toHaveText(mode === 'mobile' ? '3 人在线' : '在线 3 人');
    await page.screenshot({ path: `../../.codex-tmp/lounge-presence-${mode}.png` });
    relay.policy(false); await expect(page.locator('.lounge-online-count')).toHaveCount(0);
    await page.screenshot({ path: `../../.codex-tmp/lounge-replies-${mode}.png` });
    await openLoungeAction(page, '历史记录');
    await page.getByRole('textbox', { name: '搜索消息或账户' }).fill('reply-text');
    await expect(page.locator('.lounge-history-message .lounge-reply')).toContainText('quoted-original');
    await page.reload();
    if (mode === 'mobile') {
      await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
      await page.locator('.discovery-lounge').click();
      await page.getByRole('button', { name: '群聊', exact: true }).click();
    } else await page.getByRole('button', { name: '在线交流', exact: true }).click();
    await openLoungeAction(page, '历史记录');
    await page.getByRole('textbox', { name: '搜索消息或账户' }).fill('reply-text');
    const stored = page.locator('.lounge-history-message');
    await expect(stored.locator('.lounge-reply')).toContainText('quoted-original');
    await expectNoMenuOutsideBubble(page, stored);
    await stored.locator('.lounge-bubble').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '引用回复' }).click();
    await expect(page.locator('.lounge-reply-draft')).toContainText('reply-text');
    await expect(page.locator('.lounge-reply-draft')).not.toContainText('quoted-original');
  });
}
