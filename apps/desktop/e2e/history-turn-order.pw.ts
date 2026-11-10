import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

for (const mode of ['local', 'remote', 'web']) for (const width of [390, 1280]) {
  test(`${mode} ${width}: recovered history stays before the latest message on repeated sync`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto(`e2e/history-turn-order-harness.html?mode=${mode}${width === 390 ? '&dark' : ''}`);
    for (let sync = 0; sync < 3; sync++) {
      await expect(page.locator('main')).toHaveAttribute('data-turn-order', 'greeting,inspect,continue');
      await expect(page.getByText('你好！今天需要我帮你做什么？', { exact: true })).toHaveCount(1);
      const positions = await Promise.all([
        '你好！今天需要我帮你做什么？', '已完成清理检查，项目文件保持完整。', '正在继续处理最新任务。',
      ].map(text => page.getByText(text, { exact: true }).evaluate(element => element.getBoundingClientRect().top)));
      expect(positions[0]).toBeLessThan(positions[1]);
      expect(positions[1]).toBeLessThan(positions[2]);
      if (sync < 2) await page.getByRole('button', { name: '重新同步', exact: true }).click();
    }
    await page.screenshot({ path: resolve(process.env.HISTORY_ORDER_EVIDENCE_DIR
      ?? '../../.codex-tmp/history-order-evidence', `${mode}-${width}.png`), fullPage: true });
  });
}
