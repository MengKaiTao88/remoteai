import { test, expect } from '@playwright/test';

test('automatic ranks update and disabling restores saved manual priorities', async ({ page }, info) => {
  const mode = info.project.name;
  await page.goto(`/reset-priority-harness.html?mode=${mode}`, { waitUntil: 'domcontentloaded' });
  if (mode === 'desktop-local') {
    await page.getByRole('button', { name: '自动切号', exact: true }).hover();
    const toggle = page.locator('.proxy-auto-switch-menu-item').filter({ hasText: '按次用量重置时间排序' })
      .getByRole('switch');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('spinbutton').first()).toHaveValue('3');
    await expect(page.getByRole('spinbutton').nth(1)).toHaveValue('1');
    await expect(page.getByRole('spinbutton').first()).toBeDisabled();
    await page.screenshot({ path: `../../.artifacts/reset-priority/${mode}-enabled.png`, animations: 'disabled' });
    await toggle.click();
    await expect(page.getByRole('spinbutton').first()).toHaveValue('8');
    await expect(page.getByRole('spinbutton').nth(1)).toHaveValue('-2');
    await expect(page.getByRole('spinbutton').first()).toBeEnabled();
  } else {
    const toggle = page.locator('label').filter({ hasText: '按次用量重置时间排序' }).getByRole('switch');
    await toggle.click();
    await expect(page.locator('.reset-priority-accounts strong')).toHaveText(['1', '2', '3']);
    await page.screenshot({ path: `../../.artifacts/reset-priority/${mode}-enabled.png`, animations: 'disabled' });
    await toggle.click();
    await expect(page.locator('.reset-priority-accounts strong')).toHaveText(['-2', '3', '8']);
  }
});
