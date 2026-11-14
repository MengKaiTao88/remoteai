import { expect, test } from '@playwright/test';

const cases = ['local', 'remote', 'web'].flatMap(mode => [false, true].map(large => ({
  mode, large, width: large ? 900 : 1280, name: `${mode}-${large ? 'dark-large' : 'light'}`,
})));
cases.push(...[false, true].map(large => ({ mode: 'web', large, width: large ? 360 : 390,
  name: `mobile-web-${large ? 'dark-large' : 'light'}` })));

for (const entry of cases) test(`${entry.name}: owner resolution clears card without a second submission`, async ({ page }, info) => {
  await page.setViewportSize({ width: entry.width, height: 844 });
  await page.goto(`/e2e/question-resolution-harness.html?mode=${entry.mode}${entry.large ? '&dark&large' : ''}`);
  await expect(page.getByText('四项都有，显示正常', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`${entry.name}-waiting.png`) });
  await page.evaluate(() => {
    const fixture = (window as unknown as { questionResolution: { receive(event: unknown): void } }).questionResolution;
    fixture.receive({ method: 'serverRequest/resolved', params: {
      requestId: 'bridge:question-chat:async:old:question' } });
  });
  await expect(page.getByText('四项都有，显示正常', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('resolved')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { questionResolution: { calls: string[] } })
    .questionResolution.calls)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(entry.width);
  await page.screenshot({ path: info.outputPath(`${entry.name}-resolved.png`) });
});
