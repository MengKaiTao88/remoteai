import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { pdfAssetsPlugin } from '../../../shared/file-preview/pdfAssetsPlugin';

export default defineConfig({
  root: resolve('e2e'), plugins: [react(), pdfAssetsPlugin()],
  resolve: { dedupe: ['react', 'react-dom', 'antd', 'antd-mobile', '@ant-design/cssinjs', '@remoteai/i18n'] },
  optimizeDeps: { entries: ['queue-recovery-harness.html'] },
  cacheDir: resolve('../../.codex-tmp/queue-recovery/vite'),
  server: { host: '127.0.0.1', strictPort: true, fs: { allow: [resolve('../..')] } },
});
