import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fontSizePlugin } from '../../../shared/appearance/fontSizePlugin';

export default defineConfig({
  root: resolve('e2e'),
  plugins: [react()], css: { postcss: { plugins: [fontSizePlugin()] } },
  resolve: { dedupe: ['react', 'react-dom', 'antd', '@ant-design/cssinjs', '@remoteai/i18n'] },
  cacheDir: resolve('../../.codex-tmp/official-permissions-vite'),
  build: { outDir: resolve('../../.codex-tmp/official-permissions-browser'), emptyOutDir: false,
    rollupOptions: { input: resolve('e2e/official-permissions-harness.html') } },
  preview: { host: '127.0.0.1', strictPort: true },
});
