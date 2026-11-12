import { defineConfig } from '@playwright/test';
import { testBrowserLaunchOptions } from '../../scripts/test-browser.mjs';

export default defineConfig({
  testDir: './e2e', testMatch: 'official-permissions.pw.ts', workers: 1, timeout: 45000,
  outputDir: '../../.codex-tmp/official-permissions-results', reporter: 'list',
  use: { headless: true, launchOptions: testBrowserLaunchOptions(), locale: 'zh-CN',
    baseURL: 'http://127.0.0.1:1499', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npx vite build --config e2e/official-permissions.vite.ts && npx vite preview --config e2e/official-permissions.vite.ts --port 1499',
    url: 'http://127.0.0.1:1499/official-permissions-harness.html', timeout: 180000 },
});
