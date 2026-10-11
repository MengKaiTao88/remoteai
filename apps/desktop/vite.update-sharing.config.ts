import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  cacheDir: '../../.codex-tmp/update-sharing-vite',
  optimizeDeps: { entries: ['e2e/update-sharing-harness.html'] },
  // Browser regressions run alongside Rust builds; their target trees must not drive HMR or discovery.
  server: { watch: null, hmr: false, strictPort: true },
});
