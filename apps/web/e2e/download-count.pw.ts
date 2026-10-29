import { expect, test, type Page } from '@playwright/test';
import { navigate } from './chat-helpers';

test.setTimeout(120_000);

async function control(page: Page, action: 'startDownloads' | 'pauseDownloads' | 'finishDownloads') {
  await page.evaluate(async action => {
    const url = '/web/e2e/download-count-fixture.ts';
    const fixture = await import(/* @vite-ignore */ url) as typeof import('./download-count-fixture');
    await fixture[action](12);
  }, action);
}

test('discovery and download icons share live counts across navigation and languages', async ({ page }, info) => {
  await page.goto('./');
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('review@example.test');
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('local-review');
  await page.getByRole('button', { name: '登录并查看' }).click();
  await page.getByRole('button', { name: '同意并登录' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  await navigate(page, '发现');
  const navigation = page.locator(info.project.name === 'desktop' ? '.desktop-sidebar nav' : '.mobile-tabbar');
  const entry = page.locator('.discovery-downloads');
  // The desktop sidebar also has a separate Downloads shortcut; target the Discovery icon.
  const navCount = navigation.locator('.download-count-icon').first().getByRole('status');
  const entryCount = entry.getByRole('status');
  await expect(navCount).toHaveCount(0);
  await control(page, 'startDownloads');
  await expect(navCount).toHaveText('12');
  await expect(entryCount).toHaveText('12');
  await page.screenshot({ path: info.outputPath('active-downloads.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (info.project.name === 'desktop') {
    await page.getByRole('button', { name: '收起主菜单' }).click();
    await expect(navCount).toBeVisible();
    await page.screenshot({ path: info.outputPath('collapsed-downloads.png') });
    await page.getByRole('button', { name: '展开主菜单' }).click();
  }
  await navigate(page, '账号');
  await expect(navCount).toHaveText('12');
  await navigate(page, '发现');
  await entry.click();
  await expect(page.getByRole('article')).toHaveCount(12);
  await page.getByRole('button', { name: '返回发现' }).click();
  for (const [language, label] of [
    ['en', 'Active downloads: 12'], ['ru', 'Активные загрузки: 12'],
    ['ja', 'ダウンロード中：12 件'], ['zh', '12 项正在下载'],
  ] as const) {
    await page.evaluate(async language => {
      const url = '/web/src/i18n/index.ts';
      const { setLanguage } = await import(/* @vite-ignore */ url) as typeof import('../src/i18n');
      setLanguage(language);
    }, language);
    await expect(navCount).toHaveAttribute('aria-label', label);
    await expect(entryCount).toHaveAttribute('aria-label', label);
  }
  await control(page, 'pauseDownloads');
  await expect(navCount).toHaveCount(0);
  await expect(entryCount).toHaveCount(0);
  await control(page, 'finishDownloads');
  await expect(navCount).toHaveCount(0, { timeout: 60_000 });
  await expect(entryCount).toHaveCount(0);
});
