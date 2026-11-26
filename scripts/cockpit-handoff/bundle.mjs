import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const [, , outfile] = process.argv;
if (!outfile) throw new Error('HANDOFF_BUNDLE_OUTPUT_REQUIRED');
await build({
  entryPoints: [fileURLToPath(new URL('./host.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'linked',
});
