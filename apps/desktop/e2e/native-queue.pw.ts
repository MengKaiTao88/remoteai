import { expect, test } from '@playwright/test';

for (const mode of ['local', 'remote', 'web']) {
  for (const large of [false, true]) test(`${mode}: ${large ? 'dark enlarged' : 'light default'} owner queue and recovered local draft`, async ({ page }, info) => {
    await page.setViewportSize({ width: large ? 900 : 1280, height: 760 });
    await page.goto(`/e2e/native-queue-harness.html?mode=${mode}${large ? '&dark&large' : ''}`);
    await expect(page.getByText('再检查一次历史记录。', { exact: false })).toBeVisible();
    await expect(page.getByText('上次发送结果尚未确认，请查看聊天后决定是否重发。')).toBeVisible();
    await expect(page.getByText('发送失败，请重试。', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { queueFixture: { calls: string[] } }).queueFixture.calls)).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${mode}-${large ? 'dark-large' : 'light'}.png`) });
    await page.evaluate(() => (window as unknown as { queueFixture: { clear(): void } }).queueFixture.clear());
    await expect(page.getByText('再检查一次历史记录。', { exact: false })).toHaveCount(0);
    await expect(page.getByText('上次发送结果尚未确认，请查看聊天后决定是否重发。')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { queueFixture: { calls: string[] } }).queueFixture.calls)).toEqual([]);
  });
}

for (const large of [false, true]) test(`mobile web: ${large ? 'dark enlarged' : 'light default'} queue stays readable`, async ({ page }, info) => {
  await page.setViewportSize({ width: large ? 360 : 390, height: 844 });
  await page.goto(`/e2e/native-queue-harness.html?mode=web${large ? '&dark&large' : ''}`);
  await expect(page.getByText('再检查一次历史记录。', { exact: false })).toBeVisible();
  await expect(page.getByText('上次发送结果尚未确认，请查看聊天后决定是否重发。')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(large ? 360 : 390);
  await page.screenshot({ path: info.outputPath(`mobile-web-${large ? 'dark-large' : 'light'}.png`) });
});
