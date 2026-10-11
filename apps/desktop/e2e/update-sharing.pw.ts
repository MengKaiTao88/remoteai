import { expect, test } from '@playwright/test';

for (const width of [390, 1280]) {
  test(`sharing preferences remain readable and usable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    await page.goto('/e2e/update-sharing-harness.html', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '安装包共享' })).toBeVisible();
    await expect(page.getByText('当前网络不符合共享条件，已暂停上传。')).toBeVisible();
    await page.getByText('我的设备', { exact: true }).click();
    await page.locator('.ant-select-dropdown:visible').getByText('所有用户', { exact: true }).click();
    await expect(page.getByText('与其他用户共享时，连接双方可获知彼此的网络地址。仅共享公开安装包。')).toBeVisible();
    await page.getByLabel('仅在非计费网络上传').click();
    await expect(page.getByText('当前网络不符合共享条件，已暂停上传。')).toHaveCount(0);
    await page.getByText('1024 KiB/s', { exact: true }).click();
    await page.locator('.ant-select-dropdown:visible').getByText('2048 KiB/s', { exact: true }).click();
    await expect(page.locator('.ant-select-selection-item').filter({ hasText: '2048 KiB/s' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '上传速度上限' })).toBeEnabled();
    await page.getByRole('heading', { name: '安装包共享' }).click();
    await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('sharing-settings.png') });
  });
}
