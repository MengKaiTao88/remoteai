import { chromium, expect } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9319');
const context = browser.contexts()[0];
const page = context.pages().find(p => p.url().includes('provider-market-harness'));

async function checkNavigation() {
  await page.locator('.provider-link').filter({ hasText: 'Market Gateway' }).click();
  await expect(page.locator('.pm-browser')).toBeVisible();
  await expect.poll(() => context.pages().some(p => p.url().includes(':1500/dashboard'))).toBe(true);
  const child = context.pages().find(p => p.url().includes(':1500/dashboard'));
  await expect(child.locator('#header')).toHaveText('market-value');
  await expect(child.locator('#query')).toHaveText('?view=usage&source=remoteai&tag=a&tag=b');
  console.log('initial native request: query and custom header verified');
  await child.getByRole('link', { name: '下一页', exact: true }).click();
  await expect(child.locator('#header')).toHaveText('market-value');
  await expect(page.getByLabel('页面地址', { exact: true })).toHaveValue('http://127.0.0.1:1500/next');
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await expect(child.locator('#query')).toContainText('source=remoteai');
  await page.getByRole('button', { name: '前进', exact: true }).click();
  await expect(page.getByLabel('页面地址', { exact: true })).toHaveValue('http://127.0.0.1:1500/next');
  await Promise.all([child.waitForEvent('load'), page.getByRole('button', { name: '刷新', exact: true }).click()]);
  await expect(child.locator('#header')).toHaveText('market-value');
  console.log('native navigation, address synchronization, back, forward and reload verified');
  return child;
}

async function checkPopup(child) {
  await child.getByRole('link', { name: '在新标签中打开', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect.poll(() => context.pages().some(p => p.url().includes(':1500/popup'))).toBe(true);
  const popup = context.pages().find(p => p.url().includes(':1500/popup'));
  await expect(popup.locator('#header')).toHaveText('market-value');
  await popup.getByRole('link', { name: '跨站页面', exact: true }).click();
  await expect(popup.locator('#header')).toHaveText('none');
  console.log('popup tab and cross-origin header isolation verified');
  await page.getByRole('button', { name: '关闭 127.0.0.1', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect.poll(() => context.pages().length).toBe(2);
}

async function checkControls(child) {
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '前往页面', exact: true }).nth(1).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab', { name: 'Market Gateway', exact: true }).click();
  const address = page.getByLabel('页面地址', { exact: true });
  await address.fill('http://127.0.0.1:1500/dashboard?source=remoteai'); await address.press('Enter');
  await expect(child.locator('#header')).toHaveText('market-value');
  await page.getByRole('button', { name: '全屏展示', exact: true }).click();
  await expect(page.locator('.pm-browser')).toHaveClass(/pm-browser-fullscreen/);
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  const start = Number(await page.getByTestId('beats').textContent());
  await expect.poll(async () => Number(await page.getByTestId('beats').textContent())).toBeGreaterThan(start + 4);
  console.log('tab switching, manual address, full screen and responsive Provider polling verified');
}

async function checkCleanup() {
  await page.reload();
  await expect.poll(() => context.pages().length).toBe(1);
  console.log('renderer reload released all native child tabs');
  await page.locator('.provider-link').filter({ hasText: 'Market Gateway' }).click();
  await expect.poll(() => context.pages().length).toBe(2);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '前往页面', exact: true }).nth(1).click();
  await page.getByRole('tab', { name: 'Market Gateway', exact: true }).click();
}

try {
  if (!page) throw new Error('Native verification page not found');
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => console.log('page error', error.message));
  const child = await checkNavigation();
  await checkPopup(child);
  await checkControls(child);
  await checkCleanup();
} finally {
  await browser.close();
}
