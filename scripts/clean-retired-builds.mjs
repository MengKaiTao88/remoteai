import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanProject, parseOptions } from './clean-project.mjs';

const primaryRoot = fileURLToPath(new URL('..', import.meta.url));

export function retiredCheckout(args, primary = primaryRoot) {
  const rest = [...args];
  const flag = rest.shift();
  const checkout = rest.shift();
  if (flag !== '--checkout' || !checkout || !isAbsolute(checkout)
    || rest.some(arg => arg !== '--dry-run')) {
    throw new Error('Usage: npm run clean:retired -- --checkout <absolute retired checkout> [--dry-run]');
  }
  const root = realpathSync(checkout);
  const local = relative(realpathSync(primary), root);
  if (!local || (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`))) {
    throw new Error('Retired-checkout cleanup cannot target the primary workspace or its children.');
  }
  return { root, options: parseOptions(['--rust-cache', ...rest]) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { root, options } = retiredCheckout(process.argv.slice(2));
    console.log('Retired checkout only: stop its builds and tasks before cleanup; source and Git data are retained.');
    cleanProject(root, options);
  } catch (error) {
    console.error(`Retired cleanup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
