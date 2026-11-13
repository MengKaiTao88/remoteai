import { defineConfig } from '@playwright/test';
import { testBrowserLaunchOptions } from '../../scripts/test-browser.mjs';

export default defineConfig({
  testDir: './e2e', testMatch: 'reset-priority.pw.ts', workers: 1, timeout: 60_000,
  outputDir: '../../.codex-tmp/reset-priority/playwright', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:1592', headless: true, launchOptions: testBrowserLaunchOptions(),
    viewport: { width: 1280, height: 900 }, locale: 'zh-CN', screenshot: 'only-on-failure' },
  projects: [{ name: 'desktop-local' }, { name: 'desktop-remote' }, { name: 'web-desktop' }],
  webServer: { command: 'npx vite --config e2e/reset-priority.vite.ts --port 1592',
    url: 'http://127.0.0.1:1592/reset-priority-harness.html', timeout: 120_000 },
});
