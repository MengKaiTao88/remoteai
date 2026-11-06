import { defineConfig } from '@playwright/test';
import { testBrowserLaunchOptions } from '../../scripts/test-browser.mjs';

export default defineConfig({
  testDir: './e2e', testMatch: 'activity-disclosure.pw.ts', workers: 1, timeout: 60_000,
  outputDir: '../../.codex-tmp/activity-playwright',
  use: { baseURL: 'http://127.0.0.1:1548/e2e/', headless: true, locale: 'zh-CN',
    launchOptions: testBrowserLaunchOptions() },
  projects: [
    { name: 'desktop-local', use: { viewport: { width: 1200, height: 900 } } },
    { name: 'desktop-remote', use: { viewport: { width: 1200, height: 900 } } },
    { name: 'web-desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'web-mobile', use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: { command: 'npx vite --config e2e/activity-disclosure.vite.ts --port 1548',
    url: 'http://127.0.0.1:1548/e2e/activity-disclosure-harness.html',
    reuseExistingServer: true },
});
