import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    setupFiles: ['../../shared/localization/testLocale.ts'],
    // Bundled bridge Node tests and Rust build resources have their own runners.
    exclude: [...configDefaults.exclude, '**/.codex-tmp/**', 'src-tauri/**',
      'scripts/cli-gui-acp-process.test.mjs'],
  },
}));
