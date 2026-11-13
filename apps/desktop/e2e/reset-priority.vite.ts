import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('e2e'), plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom', 'antd', 'antd-mobile', '@ant-design/cssinjs', '@remoteai/i18n'] },
  optimizeDeps: { entries: ['reset-priority-harness.html'] },
  cacheDir: resolve('../../.codex-tmp/reset-priority/vite'),
  server: { host: '127.0.0.1', strictPort: true, fs: { allow: [resolve('../..')] } },
});
