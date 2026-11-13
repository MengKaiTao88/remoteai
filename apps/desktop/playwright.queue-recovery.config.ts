import { defineConfig } from '@playwright/test';
import { testBrowserLaunchOptions } from '../../scripts/test-browser.mjs';

export default defineConfig({
  testDir: './e2e', testMatch: 'queue-recovery.pw.ts', workers: 1, timeout: 90_000,
  outputDir: '../../.codex-tmp/queue-recovery/playwright', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:1593', headless: true, launchOptions: testBrowserLaunchOptions(),
    viewport: { width: 1280, height: 900 }, locale: 'zh-CN', screenshot: 'only-on-failure' },
  projects: [{ name: 'desktop-local' }, { name: 'desktop-remote' },
    { name: 'web-mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'web-mobile-narrow', use: { viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true } }],
  webServer: { command: 'npx vite --config e2e/queue-recovery.vite.ts --port 1593',
    url: 'http://127.0.0.1:1593/queue-recovery-harness.html', timeout: 120_000 },
});
