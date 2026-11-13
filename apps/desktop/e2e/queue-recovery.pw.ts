import { test, expect } from '@playwright/test';

test('wide tables scroll inside the message and failed drafts remain available for deliberate retry',
  async ({ page }, info) => {
    const mode = info.project.name;
    await page.goto(`/queue-recovery-harness.html?mode=${mode}`);
    const viewport = page.getByRole('region', { name: '表格', exact: true });
    await expect(viewport).toBeVisible();
    const geometry = await viewport.evaluate(element => ({
      visible: element.clientWidth, content: element.scrollWidth,
      page: document.documentElement.scrollWidth, screen: innerWidth,
      headingWidth: element.querySelector('th')!.getBoundingClientRect().width,
    }));
    expect(geometry.headingWidth).toBeGreaterThanOrEqual(140);
    expect(geometry.page).toBeLessThanOrEqual(geometry.screen + 1);
    if (mode.includes('mobile')) expect(geometry.content).toBeGreaterThan(geometry.visible);
    await expect(page.getByRole('alert')).toHaveText('Codex 已断开连接，请重新连接后继续。');
    await page.screenshot({ path: `../../.artifacts/queue-recovery/${mode}.png`, fullPage: true });
    await viewport.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    if (mode.includes('mobile')) expect(await viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await page.getByRole('button', { name: '展开表格' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: mode === 'desktop-local' ? 'Close' : '关闭表格',
      exact: true }).click();
    await expect(page.getByRole('button', { name: '立即发送', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '立即发送', exact: true }).click();
    await expect(page.getByRole('region', { name: '待发送消息' })).toHaveCount(0);
  });
