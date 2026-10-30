import { expect, test } from '@playwright/test';
import { fixtureItem, setupMarket } from './provider-market-support';
import { finishIconNetwork, setupIconNetwork } from './provider-icons-network';

test.afterEach(async ({ page }) => finishIconNetwork(page));

// Recorded website icons keep the browser checks independent of provider availability.
// Sources: https://www.deepseek.com/favicon.ico
// https://portal.volccdn.com/obj/volcfe/misc/favicon.png
for (const mode of ['local', 'hosted']) {
  for (const cards of [false, true]) {
    test(`${mode}: ${cards ? 'dark cards' : 'light table'} displays website icons and offline fallback`,
      async ({ page }, info) => {
        await setupMarket(page, mode); await setupIconNetwork(page);
        await page.setViewportSize({ width: cards ? 1000 : 1600, height: 900 });
        await page.goto(`/e2e/provider-market-harness.html?mode=${mode}&icons=1&language=zh`
          + (cards ? '&cards=1&dark=1' : ''));
        const icons = page.locator('.provider-avatar .provider-website-icon');
        await expect(icons).toHaveCount(4);
        for (const index of [0, 1, 2]) await expect(icons.nth(index).locator('img')).toHaveAttribute('data-loaded', 'true');
        await expect(icons.last().locator('img')).toHaveCount(0);
        await expect(icons.last().locator('svg')).toBeVisible();
        const before = Number(await page.getByTestId('beats').textContent());
        await expect.poll(async () => Number(await page.getByTestId('beats').textContent())).toBeGreaterThan(before + 3);
        await page.screenshot({ path: info.outputPath(`${mode}-${cards ? 'dark-cards' : 'light-table'}.png`) });
      });
  }

  test(`${mode}: market list and details use the configured website`, async ({ page }, info) => {
    const dark = mode === 'hosted';
    if (dark) await page.setViewportSize({ width: 900, height: 900 });
    await setupMarket(page, mode, true, async () => ({ total: 2, items: [
      { ...fixtureItem(), name: 'DeepSeek', pageLink: {
        url: 'https://www.deepseek.com/dashboard?token=private', query: 'session=private', headers: { 'X-Private': 'private' },
      } },
      { ...fixtureItem(), id: 'offline', name: 'Offline Provider', pageLink: null,
        baseUrl: 'https://offline.example.test/v1', balanceQuery: null },
    ] }));
    await setupIconNetwork(page);
    await page.goto(`/e2e/provider-market-harness.html?mode=${mode}${dark ? '&dark=1' : ''}`);
    await page.locator('.provider-market-button').first().click();
    await expect(page.locator('.pm-card').first().locator('img')).toHaveAttribute('data-loaded', 'true');
    const title = page.locator('.pm-card-title').first().locator('span').last();
    expect(await title.evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(30);
    await expect(page.locator('.pm-card').last().locator('.provider-website-icon svg')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${mode}-${dark ? 'dark' : 'light'}-market-list.png`) });
    await page.getByRole('button', { name: 'DeepSeek', exact: true }).click();
    await expect(page.locator('.pm-detail-title img')).toHaveAttribute('data-loaded', 'true');
    await page.screenshot({ path: info.outputPath(`${mode}-${dark ? 'dark' : 'light'}-market-detail.png`) });
  });
}

for (const mode of ['remote', 'web']) {
  for (const dark of [false, true]) {
    test(`${mode}: ${dark ? 'dark' : 'light'} remote account picker uses the same icons`, async ({ page }, info) => {
      await setupMarket(page, mode); await setupIconNetwork(page);
      await page.goto(`/e2e/provider-market-harness.html?mode=${mode}&icons=1&language=zh${dark ? '&dark=1' : ''}`);
      await page.getByRole('button', { expanded: false }).click();
      const icons = page.locator('.ant-popover .provider-website-icon');
      await expect(icons).toHaveCount(4);
      for (const index of [0, 1, 2]) await expect(icons.nth(index).locator('img')).toHaveAttribute('data-loaded', 'true');
      await expect(icons.last().locator('img')).toHaveCount(0);
      await expect(icons.last().locator('svg')).toBeVisible();
      await page.screenshot({ path: info.outputPath(`${mode}-${dark ? 'dark' : 'light'}-picker.png`) });
    });
  }
}
