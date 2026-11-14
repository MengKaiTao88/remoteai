import { defineConfig } from '@playwright/test';
import config from './playwright.pdf-continuous.config';

export default defineConfig(config, {
  testMatch: 'question-resolution.pw.ts',
  outputDir: '../../../.artifacts/question-sync-repair/browser-results',
});
