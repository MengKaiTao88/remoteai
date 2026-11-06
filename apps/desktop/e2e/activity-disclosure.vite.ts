import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fontSizePlugin } from '../../../shared/appearance/fontSizePlugin';
import { pdfAssetsPlugin } from '../../../shared/file-preview/pdfAssetsPlugin';

export default defineConfig({
  root: resolve('e2e'), base: '/e2e/', plugins: [react(), pdfAssetsPlugin()],
  css: { postcss: { plugins: [fontSizePlugin()] } },
  cacheDir: resolve('../../.codex-tmp/activity-vite'),
  optimizeDeps: { entries: ['activity-disclosure-harness.html'] },
  resolve: { dedupe: ['react', 'react-dom', 'antd', 'antd-mobile', '@remoteai/i18n'] },
  server: { host: '127.0.0.1', strictPort: true },
});
