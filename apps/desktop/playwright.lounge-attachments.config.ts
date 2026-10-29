import { defineConfig } from '@playwright/test';
import lounge from './playwright.lounge.config';

export default defineConfig({ ...lounge, testMatch: ['lounge-attachments.pw.ts'],
  outputDir: '../../.codex-tmp/lounge-files/playwright', timeout: 90_000 });
