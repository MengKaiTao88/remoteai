import { openLoungeAction, expectLoungeAction, expectLoungePresence } from './lounge-mobile-actions';
import { expect, test } from '@playwright/test';
import { setupLounge, pixel } from './lounge-support';

for (const mode of ['local', 'remote', 'web', 'mobile']) {
  test(`${mode}: private threads, one-way blocking, unread and durable people`, async ({ page }) => {
    test.setTimeout(120_000);
    const mobile = mode === 'mobile';
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const relay = await setupLounge(page, mode === 'web' || mobile);
    await page.goto(mode === 'web' || mobile ? 'http://127.0.0.1:1486/web/' : `/e2e/lounge-harness.html?mode=${mode}`);
    await relay.ready();
    const enter = async () => {
      if (mobile) {
        await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
        await page.locator('.discovery-lounge').click();
        await page.getByRole('button', { name: '群聊', exact: true }).click();
      } else await page.getByRole('button', { name: '在线交流', exact: true }).click();
    };
    const people = async () => { if (mobile) await page.getByRole('button', { name: /^聊天/ }).click(); };
    await enter(); relay.push('group-before-private');
    await people();
    const person = page.locator('.lounge-person, .lounge-chat-row-main')
      .and(page.getByRole('button', { name: '与 bob 私聊', exact: true })).filter({ visible: true });
    await expect(person).toHaveCount(0);
    if (mobile) await expect(page.getByRole('button', { name: '群聊', exact: true })).toBeVisible();
    else await expect(page.getByText('暂无私聊，可从群聊消息菜单发起。')).toBeVisible();
    await page.reload(); await relay.ready(); await enter(); await people();
    await expect(person).toHaveCount(0);
    relay.private('unsolicited-private', { id: 'carol', account: 'carol@example.test' });
    await expect(page.getByRole('button', { name: '与 carol 私聊', exact: true })
      .filter({ visible: true })).toBeVisible();
    await expect(person).toHaveCount(0);
    if (mobile) await page.getByRole('button', { name: '群聊', exact: true }).click();
    await page.locator('.lounge-message').filter({ hasText: 'group-before-private' })
      .locator('.lounge-bubble').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '发起私聊' }).click();
    await people();
    await expect(person).toBeVisible();
    if (!mobile) {
      await expect(person.locator('small')).toHaveCount(0);
      await expect(person).toHaveAccessibleDescription('在线');
    }
    if (mobile) {
      // Wait for the sliding drawer to settle before synthesizing viewport touch coordinates.
      await person.hover();
      const bounds = (await person.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      const pointer = { pointerId: 2, pointerType: 'touch', button: 0, isPrimary: true,
        clientX: bounds.x + 20, clientY: bounds.y + 20 };
      await person.dispatchEvent('pointerdown', pointer);
      await expect(page.getByRole('menuitem', { name: '发起私聊' })).toBeVisible();
      await person.dispatchEvent('pointerup', pointer);
    } else await person.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: '屏蔽此人', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: '发起私聊' }).click();
    await expectLoungePresence(page, '在线');
    await expect(page.getByRole('menuitem', { name: '发起私聊' })).toBeHidden();
    await expect(page.locator('.lounge-message')).toHaveCount(0);
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('private-mixed');
    await page.locator('.lounge-composer input[type=file]').setInputFiles({ name: 'image.png', mimeType: 'image/png',
      buffer: Buffer.from(pixel.split(',')[1], 'base64') });
    await page.getByRole('button', { name: '表情', exact: true }).click();
    await page.getByRole('button', { name: '😀', exact: true }).click();
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(input).toHaveValue('');
    expect(relay.sent.at(-1)?.to).toBe('bob'); expect(relay.sent.at(-1)?.images).toHaveLength(1);
    relay.private('private-reply'); await expect(page.getByText('private-reply', { exact: true })).toBeVisible();
    relay.push('group-unread');
    await expect(page.getByText('group-unread', { exact: true })).toHaveCount(0);
    await openLoungeAction(page, '屏蔽此人');
    await page.getByRole('dialog').getByRole('button', { name: '屏蔽此人', exact: true }).click();
    await expectLoungeAction(page, '取消屏蔽');
    await expectLoungePresence(page, '在线');
    relay.private('blocked-private'); relay.push('blocked-group');
    await input.fill('blocker-can-send'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(input).toHaveValue(''); expect(relay.sent.at(-1)?.to).toBe('bob');
    await expect(page.getByText('blocked-private', { exact: true })).toHaveCount(0);
    relay.contact(false); await expectLoungePresence(page, '离线');
    relay.contact(null); await expectLoungePresence(page, '在线状态不可见');
    await page.screenshot({ path: `../../.codex-tmp/lounge-direct-${mode}.png` });
    await people();
    await page.getByRole('button', { name: /群聊$/ }).filter({ visible: true }).click();
    await expect(page.getByText('group-before-private', { exact: true })).toBeVisible();
    await expect(page.getByText('blocked-group', { exact: true })).toHaveCount(0);
    await expect(page.getByText('private-reply', { exact: true })).toHaveCount(0);
    await page.reload(); await relay.ready(); await enter(); await people(); await person.click();
    await expect(page.getByText('private-reply', { exact: true })).toBeVisible();
    await openLoungeAction(page, '历史记录');
    await page.getByRole('textbox', { name: '搜索消息或账户' }).fill('private');
    await expect(page.locator('.lounge-history-message')).toHaveCount(2);
    await page.getByRole('textbox', { name: '搜索消息或账户' }).fill('group');
    await expect(page.locator('.lounge-history-message')).toHaveCount(0);
    await page.locator('.ant-drawer-close:visible').click();
    await openLoungeAction(page, '取消屏蔽');
    await page.getByRole('dialog').getByRole('button', { name: '取消屏蔽', exact: true }).click();
    await expectLoungeAction(page, '屏蔽此人');
    relay.private('after-unblock'); await expect(page.getByText('after-unblock', { exact: true })).toBeVisible();
  });
}

for (const mode of ['local', 'remote', 'web', 'mobile']) {
  test(`${mode}: avatar opens private chat and sending retains input focus`, async ({ page }) => {
    const mobile = mode === 'mobile';
    const web = mode === 'web' || mobile;
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const relay = await setupLounge(page, web);
    await page.goto(web ? 'http://127.0.0.1:1486/web/' : `/e2e/lounge-harness.html?mode=${mode}`);
    await relay.ready();
    if (mobile) {
      await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
      await page.locator('.discovery-lounge').click();
      await page.getByRole('button', { name: '群聊', exact: true }).click();
    } else await page.getByRole('button', { name: '在线交流', exact: true }).click();
    relay.push('avatar-entry-message');
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    const send = page.getByRole('button', { name: '发送', exact: true });
    await input.fill('first group message');
    await input.evaluate(node => {
      node.dataset.blurs = '0';
      node.addEventListener('blur', () => { node.dataset.blurs = String(Number(node.dataset.blurs) + 1); });
    });
    await send.click();
    await expect.poll(() => relay.sent.at(-1)?.text).toBe('first group message');
    await expect(input).toBeFocused(); await expect(input).toBeEditable();
    await expect(input).toHaveValue('');
    await input.fill('next group message');
    await expect(send).toBeEnabled();
    await expect(input).toHaveValue('next group message');
    await send.click(); await expect(input).toHaveValue(''); await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('data-blurs', '0');
    await page.locator('.lounge-message').filter({ hasText: 'avatar-entry-message' })
      .getByRole('button', { name: mobile ? '查看 bob 的资料' : '与 bob 私聊', exact: true }).click();
    if (mobile) await page.getByRole('button', { name: '发消息', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'bob', exact: true })).toBeVisible();
    await input.fill('first private message'); await send.click();
    await expect(input).toHaveValue(''); await expect(input).toBeFocused();
    await expect.poll(() => relay.sent.at(-1)?.to).toBe('bob');
    await input.fill('waiting for a reply'); await send.click();
    await expect(page.getByRole('alert')).toHaveText('对方回复后才能继续发送。');
    await expect(input).toBeFocused();
    relay.private('reply unlocks sending');
    await expect(page.getByText('reply unlocks sending', { exact: true })).toBeVisible();
    await send.click(); await expect(input).toHaveValue(''); await expect(input).toBeFocused();
    await page.screenshot({ path: `../../.codex-tmp/lounge-interactions-${mode}.png` });
    if (mobile) await page.getByRole('button', { name: '聊天', exact: true }).click();
    await page.getByRole('button', { name: '群聊', exact: true }).filter({ visible: true }).click();
    await openLoungeAction(page, '历史记录');
    await page.locator('.lounge-history-message').filter({ hasText: 'avatar-entry-message' })
      .getByRole('button', { name: mobile ? '查看 bob 的资料' : '与 bob 私聊', exact: true }).click();
    if (mobile) await page.getByRole('button', { name: '发消息', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '历史记录', exact: true })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'bob', exact: true })).toBeVisible();
  });
}
