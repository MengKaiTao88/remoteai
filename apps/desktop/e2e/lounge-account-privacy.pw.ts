import { expect, test } from '@playwright/test';
import { setupLounge } from './lounge-support';

test.setTimeout(120_000);

for (const mode of ['local', 'remote', 'web', 'mobile-320', 'mobile-390']) {
  test(`${mode}: account prefixes in live chat, profiles and restored history`, async ({ page }) => {
    const mobile = mode.startsWith('mobile'), web = mobile || mode === 'web';
    if (mobile) await page.setViewportSize({ width: Number(mode.split('-')[1]), height: 844 });
    const relay = await setupLounge(page, web);
    const enter = async () => {
      if (!mobile) return page.getByRole('button', { name: '在线交流', exact: true }).click();
      await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
      await page.locator('.discovery-lounge').click();
      await page.getByRole('button', { name: '群聊', exact: true }).click();
    };
    await page.goto(web ? 'http://127.0.0.1:1486/web/' : `/e2e/lounge-harness.html?mode=${mode}`);
    await relay.ready(); await enter();
    relay.frame({ type: 'ready', user: { id: 'alice', account: 'alice' }, direct: true, receipts: true });
    relay.frame({ type: 'message', id: 'prefix-message', sender: { id: 'carol', account: 'carol' },
      text: '接口只返回前缀', images: [], sentAt: new Date().toISOString() });
    relay.push('旧记录也只显示前缀', [], { id: 'old', senderId: 'bob', account: 'bob@example.test',
      text: '旧引用内容', imageCount: 0 });
    await expect(page.locator('.lounge-conversation')).toContainText('接口只返回前缀');
    await expect(page.locator('.lounge-conversation')).toContainText('旧引用内容');
    await expect(page.locator('.lounge-conversation')).not.toContainText('@example.test');
    if (mobile) await page.getByRole('button', { name: '查看 bob 的资料', exact: true }).first().click();
    else {
      await page.locator('.lounge-conversation').getByRole('button', { name: '与 bob 私聊', exact: true }).click();
      await page.locator('.lounge-people-list').getByRole('button', { name: '与 bob 私聊', exact: true })
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: '个人资料', exact: true }).click();
    }
    await expect(page.getByRole('dialog')).toContainText('bob');
    await expect(page.getByRole('dialog')).not.toContainText('@');
    await expect(page.getByRole('dialog')).toBeVisible();
    if (!mobile) await expect(page.locator('.ant-modal')).not.toHaveClass(/ant-zoom-(appear|enter)/);
    await page.screenshot({ path: `../../.codex-tmp/lounge-privacy-${mode}-profile.png`, animations: 'disabled' });
    if (mobile) await page.getByRole('button', { name: '返回', exact: true }).click();
    else await page.locator('.ant-modal-close').click();
    await page.reload(); await relay.ready(); await enter();
    await expect(page.locator('.lounge-conversation')).toContainText('旧记录也只显示前缀');
    await expect(page.locator('.lounge-conversation')).not.toContainText('@example.test');
    await page.screenshot({ path: `../../.codex-tmp/lounge-privacy-${mode}-history.png`, animations: 'disabled' });
  });
}
