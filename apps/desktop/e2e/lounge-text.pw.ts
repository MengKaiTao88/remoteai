import { expect, test, type Locator } from '@playwright/test';
import { setupLounge } from './lounge-support';

async function expectCompleteText(text: Locator, singleLine: boolean) {
  await expect(text).toBeVisible();
  const layout = await text.evaluate(node => {
    const bounds = node.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    const lines = [...range.getClientRects()];
    return {
      lines: new Set(lines.filter(line => line.width > 0).map(line => line.y)).size,
      contained: lines.every(line => line.left >= bounds.left - 1 && line.right <= bounds.right + 1
        && line.top >= bounds.top - 1 && line.bottom <= bounds.bottom + 1),
    };
  });
  expect(layout.contained).toBe(true);
  if (singleLine) expect(layout.lines).toBe(1);
  else expect(layout.lines).toBeGreaterThan(1);
}

for (const width of [320, 390]) {
  for (const scale of [1, 1.3]) {
    test(`mobile message text ${width}px at font scale ${scale}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const relay = await setupLounge(page, true);
      await page.goto('http://127.0.0.1:1486/web/'); await relay.ready();
      await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
      await page.locator('.discovery-lounge').click();
      await page.getByRole('button', { name: '群聊', exact: true }).click();
      await page.addStyleTag({ content: `.lounge-mobile .lounge-text { font-size: ${14 * scale}px; }` });
      relay.push('开始私聊');
      await page.getByRole('button', { name: '查看 bob 的资料', exact: true }).click();
      await page.getByRole('button', { name: '发消息', exact: true }).click();
      relay.private('收到');
      const input = page.getByRole('textbox', { name: '消息', exact: true });
      for (const value of ['hi', '你好', 'Hi 你好 👋', '第一行\n第二行', '长消息需要完整换行，'.repeat(8)]) {
        await input.fill(value); await page.getByRole('button', { name: '发送', exact: true }).click();
        const text = page.locator('.lounge-message.is-own .lounge-text').filter({ hasText: value }).last();
        await expectCompleteText(text, !value.includes('\n') && value.length < 20);
        relay.private(value);
        await expectCompleteText(page.locator('.lounge-message:not(.is-own) .lounge-text')
          .filter({ hasText: value }).last(), !value.includes('\n') && value.length < 20);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `../../.codex-tmp/lounge-text-web-${width}-${scale}.png` });
    });
  }
}
