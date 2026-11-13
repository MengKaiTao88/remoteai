import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Export an explicitly selected, committed shared change without replacing unrelated snapshots.
const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = path.join(root, 'apps/web/vendor');
const manifestPath = path.join(vendor, 'source-lock.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const files = process.argv.slice(2);
if (!files.length) throw new Error('Specify committed shared source files to export.');
const shared = path.join(root, 'shared');
const git = args => execFileSync('git', args, { cwd: shared, windowsHide: true });
const revision = git(['rev-parse', 'HEAD']).toString().trim();
const repository = 'https://github.com/MengKaiTao88/remoteai-shared.git';
const prepared = files.map(relative => {
  if (!/^shared\/[\w./-]+\.(?:[cm]?[jt]sx?|css|less)$/.test(relative)
    || relative.split('/').includes('..')) throw new Error(`Invalid shared source path: ${relative}`);
  const target = path.resolve(vendor, relative);
  if (!target.startsWith(vendor + path.sep)) throw new Error('Export must remain inside Web vendor.');
  const contents = Buffer.from(git(['show', `HEAD:${relative.slice('shared/'.length)}`])
    .toString('utf8').replaceAll('\r\n', '\n').replace(/\n+$/, '\n'));
  return { relative, target, contents };
});
for (const { relative, target, contents } of prepared) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  manifest.files[relative] = createHash('sha256').update(contents).digest('hex');
  manifest.sourceOverlays ??= {};
  manifest.sourceOverlays[relative] = { repository, revision };
}
manifest.i18n = JSON.parse(fs.readFileSync(path.join(root, 'apps/web/package.json'), 'utf8'))
  .dependencies['@remoteai/i18n'];
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Exported ${prepared.length} committed shared files with per-file provenance.`);
