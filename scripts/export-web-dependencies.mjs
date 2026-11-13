import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSourceBoundaries } from '../shared/scripts/source-boundaries.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const arguments_ = process.argv.slice(2);
const sharedOnly = arguments_.includes('--shared-only');
const retainTests = arguments_.includes('--retain-tests');
const isTestFixture = relative => relative.startsWith('apps/desktop/e2e/');
const destination = path.resolve(arguments_.find(value => !value.startsWith('--'))
  ?? path.join(root, 'apps/web'));
const vendor = path.join(destination, 'vendor');
const boundaries = inspectSourceBoundaries({ shared: path.join(root, 'shared'), applications: [destination] });
if (boundaries.violations.length) throw new Error(JSON.stringify(boundaries.violations, null, 2));
const sourcePattern = /\.(?:[cm]?[jt]sx?|css|less|html)$/;
const textPattern = /\.(?:[cm]?[jt]sx?|css|less|html|json|md|svg|txt|sig)$/;
const slash = value => value.replaceAll('\\', '/');
const hash = contents => createHash('sha256').update(contents).digest('hex');
const hostDependencies = [
  'scripts/test-browser.mjs', 'scripts/test-browser.d.mts', 'scripts/i18n-fixture.mjs',
  'apps/desktop/scripts/vite.config.ts', 'apps/desktop/e2e/chat-harness.html',
  'apps/desktop/e2e/chat-harness.ts', 'apps/desktop/e2e/mobile-fixture.mjs',
  'apps/desktop/src-tauri/icons/32x32.png', 'apps/desktop/src-tauri/icons/128x128.png',
  'apps/desktop/src-tauri/tauri.conf.json', 'shared/localization/testLocale.ts',
];
const manifestPath = path.join(vendor, 'source-lock.json');
const previousManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : undefined;
if (sharedOnly && !previousManifest) throw new Error('A shared-only export requires an existing dependency snapshot.');
const previous = previousManifest?.files ?? {};
const pending = new Set(sharedOnly
  ? Object.keys(previous).filter(name => name.startsWith('shared/')) : hostDependencies);
// Shared changes must not replace a newer published host or Native snapshot with this checkout's versions.
if (retainTests) for (const relative of Object.keys(previous).filter(isTestFixture)) pending.add(relative);
const files = sharedOnly
  ? Object.fromEntries(Object.entries(previous).filter(([name]) => !name.startsWith('shared/'))) : {};

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['.git', '.workspace', '.codex-tmp', 'node_modules', 'vendor', 'dist'].includes(entry.name)) return [];
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(filename) : [filename];
  });
}

function resolveSource(filename) {
  const plain = filename.split('?')[0];
  return ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.d.ts', '/index.ts', '/index.tsx', '/index.js']
    .map(suffix => plain + suffix).find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function collect(filename) {
  const source = resolveSource(filename);
  if (!source) return;
  const relative = slash(path.relative(root, source));
  if (sharedOnly && !relative.startsWith('shared/')) return;
  if (retainTests && isTestFixture(relative)) return;
  // Web is the host, and translations are supplied by the installed public package.
  if (/^(shared|apps\/(desktop|native)|scripts)\//.test(relative)) pending.add(relative);
}

function references(content, directory) {
  for (const match of content.matchAll(/(['"])(\.{1,2}\/[^'"\r\n]+)\1/g)) {
    collect(path.resolve(directory, match[2].split('?')[0]));
  }
  for (const match of content.matchAll(/url\(\s*['"]?(\.{1,2}\/[^)'"\s]+)['"]?\s*\)/g)) {
    collect(path.resolve(directory, match[1]));
  }
  for (const match of content.matchAll(/\/e2e\/([\w-]+\.(?:html|tsx?|jsx?))/g)) {
    collect(path.join(root, 'apps/desktop/e2e', match[1]));
  }
}

for (const filename of walk(destination).filter(filename => sourcePattern.test(filename))) {
  const original = path.join(root, 'apps/web', path.relative(destination, filename));
  references(fs.readFileSync(filename, 'utf8'), path.dirname(original));
}

fs.mkdirSync(vendor, { recursive: true });
for (const relative of pending) {
  // Business-only updates keep the prior test fixtures and their original source provenance.
  if (retainTests && isTestFixture(relative)) {
    let contents = fs.readFileSync(path.join(vendor, relative));
    if (textPattern.test(relative)) contents = Buffer.from(contents.toString('utf8').replaceAll('\r\n', '\n'));
    if (hash(contents) !== previous[relative]) throw new Error(`Changed retained fixture: ${relative}`);
    files[relative] = previous[relative];
    if (sourcePattern.test(relative)) references(contents.toString('utf8'), path.dirname(path.join(root, relative)));
    continue;
  }
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) throw new Error(`Missing Web integration dependency: ${relative}`);
  let contents = fs.readFileSync(source);
  if (textPattern.test(relative)) contents = Buffer.from(contents.toString('utf8').replaceAll('\r\n', '\n'));
  // Trim extra code-only EOF lines without trimming signed payloads or other assets.
  if (/\.(?:[cm]?[jt]sx?|css|less)$/.test(relative)) {
    contents = Buffer.from(contents.toString('utf8').replace(/\n+$/, '\n'));
  }
  files[relative] = hash(contents);
  const target = path.join(vendor, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  if (sourcePattern.test(relative)) references(contents.toString('utf8'), path.dirname(source));
  if (relative.endsWith('.js')) collect(source.replace(/\.js$/, '.d.ts'));
}

const git = cwd => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const repository = cwd => {
  const remotes = execFileSync('git', ['remote'], { cwd, encoding: 'utf8' }).trim().split(/\s+/);
  const origin = execFileSync('git', ['remote', 'get-url', remotes.includes('personal') ? 'personal' : 'origin'],
    { cwd, encoding: 'utf8' }).trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(origin);
  if (!match) throw new Error('Dependency provenance requires a credential-free GitHub repository URL.');
  return `https://github.com/${match[1]}`;
};
const metadata = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
const i18n = metadata.dependencies['@remoteai/i18n'];
const releaseArchive = new RegExp('^https://github\\.com/(?:piperhex|MengKaiTao88)/remoteai-i18n/releases/download/'
  + 'i18n-v([\\w.+-]+)/remoteai-i18n-\\1\\.tgz$');
if (!releaseArchive.test(i18n)) {
  throw new Error('Web must pin a published @remoteai/i18n release before exporting dependencies.');
}
const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').replaceAll('\r\n', '\n').replace(/\n+$/, '\n');
fs.writeFileSync(path.join(vendor, 'LICENSE'), license);
files.LICENSE = hash(license);
const snapshotFiles = sharedOnly ? Object.fromEntries([
  ...Object.keys(previous), ...Object.keys(files).filter(name => !Object.hasOwn(previous, name)),
].filter(name => Object.hasOwn(files, name)).map(name => [name, files[name]])) : files;
const nativeSource = sharedOnly ? previousManifest.nativeSource
  : fs.existsSync(path.join(root, 'apps/native/.git')) ? {
    repository: repository(path.join(root, 'apps/native')), revision: git(path.join(root, 'apps/native')),
  } : undefined;
fs.writeFileSync(manifestPath, JSON.stringify({
  repository: repository(root), revision: sharedOnly ? previousManifest.revision : git(root),
  sharedSource: { repository: repository(path.join(root, 'shared')), revision: git(path.join(root, 'shared')) },
  ...(nativeSource ? { nativeSource } : {}),
  i18n, files: snapshotFiles,
}, null, 2) + '\n');
for (const relative of Object.keys(previous)) {
  const target = path.resolve(vendor, relative);
  if (!Object.hasOwn(files, relative) && target.startsWith(vendor + path.sep)) fs.rmSync(target, { force: true });
}
console.log(`Exported ${Object.keys(files).length} Web integration dependencies to ${vendor}`);
