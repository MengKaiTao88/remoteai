import { expect, test, type Page } from '@playwright/test';
import { pixel, setupLounge } from './lounge-support';
import { openLoungeAction } from './lounge-mobile-actions';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function enter(page: Page, mobile: boolean) {
  if (mobile) {
    await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
    await page.locator('.discovery-lounge').click(); await button(page, '群聊').click();
  } else await button(page, '在线交流').click();
}

for (const mode of ['local', 'remote', 'web', 'mobile']) {
  test(`${mode}: full quotes locate live and archived originals, preserve drafts and work offline`, async ({ page }) => {
    test.setTimeout(120_000);
    const mobile = mode === 'mobile'; const web = mobile || mode === 'web';
    if (mobile) await page.setViewportSize({ width: 320, height: 844 });
    const relay = await setupLounge(page, web);
    await page.goto(web ? 'http://127.0.0.1:1486/web/' : `/e2e/lounge-harness.html?mode=${mode}`);
    await relay.ready(); await enter(page, mobile);
    const text = '第一行完整引用\n第二行中文 😀\n第三行也应完整显示';
    const reference = relay.push(text, [pixel]);
    relay.push('live reply', [], reference);
    const reply = page.locator('.lounge-message').filter({ hasText: 'live reply' });
    await expect(reply.locator('.lounge-reply-text')).toHaveText(text);
    await expect(reply.locator('.lounge-reply time')).toBeVisible();
    await expect(reply.locator('.lounge-reply-image')).toBeVisible();
    const dimensions = await reply.locator('.lounge-reply-text').evaluate(element => ({
      client: element.clientHeight, scroll: element.scrollHeight, clamp: getComputedStyle(element).webkitLineClamp,
    }));
    expect(dimensions.client).toBeGreaterThanOrEqual(dimensions.scroll); expect(dimensions.clamp).toBe('none');
    await page.screenshot({ path: `../../.codex-tmp/lounge-quote-full-${mode}.png` });
    const input = page.getByRole('textbox', { name: '消息', exact: true }); await input.fill('keep this draft');
    await reply.getByRole('button', { name: '查看原消息' }).click();
    await expect(page.locator('.is-highlighted .lounge-bubble')).toContainText(text);
    await button(page, '回到最新消息').click();
    for (let index = 0; index < 220; index++) relay.push(`filler-${index}`);
    relay.push('archived reply', [], reference);
    const archived = page.locator('.lounge-message').filter({ hasText: 'archived reply' });
    await expect(archived).toBeVisible();
    await expect(archived.locator('.lounge-reply time')).toBeVisible({ timeout: 30_000 });
    await archived.getByRole('button', { name: '查看原消息' }).click();
    await expect(page.locator('.is-highlighted')).toBeInViewport();
    await expect(page.locator('.is-highlighted .lounge-bubble')).toContainText(text);
    await expect(input).toHaveValue('keep this draft');
    relay.push('arrived while viewing original');
    await expect(page.locator('.lounge-conversation')).not.toContainText('arrived while viewing original');
    await page.getByRole('button', { name: /^回到最新消息/ }).click();
    await expect(page.locator('.lounge-conversation')).toContainText('arrived while viewing original');
    relay.push('missing reply', [], { ...reference, id: 'missing' });
    await page.locator('.lounge-message').filter({ hasText: 'missing reply' })
      .getByRole('button', { name: '查看原消息' }).click();
    await expect(page.getByText('原消息未保存在本机，暂时无法定位。', { exact: true })).toBeVisible();
    // Wait for the burst to finish persisting before simulating an application restart.
    await openLoungeAction(page, '历史记录');
    await page.getByRole('textbox', { name: '搜索消息或账户' }).fill('archived reply');
    await expect(page.locator('.lounge-history-message')).toContainText('archived reply', { timeout: 30_000 });
    await page.reload(); await enter(page, mobile);
    await page.context().setOffline(true);
    await openLoungeAction(page, '历史记录');
    await page.getByRole('textbox', { name: '搜索消息或账户' }).fill('archived reply');
    await page.locator('.lounge-history-message').getByRole('button', { name: '查看原消息' }).click();
    await expect(page.getByRole('dialog', { name: '历史记录', exact: true })).toBeHidden();
    await expect(page.locator('.is-highlighted')).toBeInViewport();
    await expect(page.locator('.is-highlighted .lounge-bubble')).toContainText(text);
  });
}

test('mobile own profile: message identity, avatar cancellation, failure and successful save', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = await setupLounge(page, true);
  await page.goto('http://127.0.0.1:1486/web/'); await relay.ready(); await enter(page, true);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('hi'); await button(page, '发送').click();
  const own = page.locator('.lounge-message.is-own');
  await expect(own.locator('.lounge-account')).toHaveText('alice');
  await expect(own.locator('.lounge-message-time')).toBeVisible();
  await own.getByRole('button', { name: '查看 alice 的资料' }).click();
  const profile = page.locator('.lounge-profile');
  await expect(profile).toContainText('alice');
  await expect(profile.getByRole('button', { name: '删除', exact: true })).toHaveCount(0);
  await button(page, '修改头像').click();
  const dialog = page.getByRole('dialog', { name: '设置头像' });
  await dialog.getByRole('button', { name: /^取\s*消$/ }).click();
  await expect(profile).toBeVisible(); await button(page, '修改头像').click();
  await dialog.locator('input[type=file]').setInputFiles({ name: 'avatar.png', mimeType: 'image/png',
    buffer: Buffer.from(pixel.split(',')[1], 'base64') });
  relay.rejectAvatar(true); await dialog.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  relay.rejectAvatar(false); await dialog.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(profile.locator('.lounge-avatar img')).toHaveAttribute('src', relay.savedAvatar());
  await page.screenshot({ path: '../../.codex-tmp/lounge-self-profile.png' });
  await button(page, '返回').click();
  await expect(own.locator('.lounge-avatar img')).toHaveAttribute('src', relay.savedAvatar());
});

test('mobile quote and own profile copy switches languages offline', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const relay = await setupLounge(page);
  await page.goto('/e2e/lounge-harness.html?mobile'); await relay.ready();
  await button(page, '在线交流').click(); await button(page, '群聊').click();
  relay.push('quoted response', [], { id: 'missing', senderId: 'bob', account: 'bob', text: '引用内容', imageCount: 0 });
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('hi'); await button(page, '发送').click();
  await button(page, '查看原消息').click();
  await page.context().setOffline(true);
  for (const [language, view, edit, missing] of [
    ['en', 'View original message', 'Change avatar', "The original message isn't saved on this device."],
    ['ja', '元のメッセージを表示', 'アバターを変更', '元のメッセージがこの端末に保存されていないため、表示できません。'],
    ['ru', 'Показать исходное сообщение', 'Изменить аватар', 'Исходное сообщение не сохранено на этом устройстве.'],
    ['zh', '查看原消息', '修改头像', '原消息未保存在本机，暂时无法定位。'],
  ] as const) {
    await page.evaluate(value => window.loungeFixture.setLanguage(value), language);
    await expect(button(page, view)).toBeVisible(); await expect(page.getByText(missing, { exact: true })).toBeVisible();
    await page.locator('.lounge-message.is-own .lounge-avatar-direct').click();
    await expect(button(page, edit)).toBeVisible();
    await expect(page.locator('.lounge-profile')).not.toContainText('client.lounge.');
    await page.locator('.lounge-profile .lounge-mobile-heading button').click();
  }
});
