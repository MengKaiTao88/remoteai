import { existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, planCleanup, removePlannedPath, safePath } from './lib/clean-project-safety.mjs';
import { repositoryTargets, rustCachePaths, taskBuildPaths, temporaryTargets } from './lib/clean-project-targets.mjs';
import { assertPackagingCleanupAvailable } from './lib/packaging-lock.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const help = `Usage: npm run clean -- [options]
  --dry-run              Preview without deleting files (npm run clean:preview)
  --build                Only build output and test reports
  --ai                   Only AI scratch directories
  --task                 Only completed packaging's temporary frontend; keep reusable caches
  --rust-cache           Only Rust targets; use for retired checkouts, not routine main-workspace cleanup
  --include-submodules   Also clean known output in initialized submodules
  --help                 Show this help

Default: build output and AI scratch directories in the parent repository.
Only listed, Git-ignored paths are eligible. Dependencies, tracked files,
configuration, dependency snapshots, links and nested repositories are preserved.
Stop builds, development servers and AI tasks before deleting their temporary files.`;

export function parseOptions(args) {
  const allowed = new Set(['--dry-run', '--build', '--ai', '--task', '--rust-cache', '--include-submodules', '--help']);
  for (const argument of args) {
    if (!allowed.has(argument)) throw new Error(`Unknown option: ${argument}. Use --help.`);
  }
  const narrow = args.includes('--task') || args.includes('--rust-cache');
  if (narrow && args.filter(arg => ['--task', '--rust-cache', '--build', '--ai', '--include-submodules']
    .includes(arg)).length !== 1) throw new Error('Narrow cleanup modes cannot be combined with other scopes.');
  const selected = narrow || args.includes('--build') || args.includes('--ai');
  return {
    dryRun: args.includes('--dry-run'), includeSubmodules: args.includes('--include-submodules'),
    build: !selected || args.includes('--build'), ai: !selected || args.includes('--ai'),
    task: args.includes('--task'), rustCache: args.includes('--rust-cache'),
    help: args.includes('--help'),
  };
}

function collectPlans(root, options) {
  if (options.task || options.rustCache) {
    return [planCleanup(root, options.task ? taskBuildPaths : rustCachePaths)];
  }
  const modules = new Set(git(root, ['ls-files', '--stage', '-z']).split('\0')
    .filter(line => line.startsWith('160000 ')).map(line => line.slice(line.indexOf('\t') + 1)));
  const plans = [];
  for (const target of repositoryTargets()) {
    const childRoot = join(root, target.path);
    if (target.path !== '.') {
      if (!options.includeSubmodules || !modules.has(target.path)) continue;
      if (!existsSync(join(childRoot, '.git'))) continue;
      if (!safePath(root, target.path)) throw new Error(`Submodule path is a link: ${target.path}`);
    }
    const candidates = options.build ? [...target.build] : [];
    if (options.ai) candidates.push(...temporaryTargets(childRoot, target.temporaryRoots));
    plans.push(planCleanup(childRoot, candidates));
  }
  return plans;
}

export function cleanProject(root, options, log = console.log) {
  root = realpathSync(root);
  if (options.task && !options.dryRun) assertPackagingCleanupAvailable(root);
  // Build every plan before deleting anything, so discovery failures leave the tree intact.
  const plans = collectPlans(root, options);
  let removed = 0;
  for (const plan of plans) {
    const display = path => relative(root, join(plan.root, path)).replaceAll('\\', '/');
    for (const entry of plan.skipped) log(`SKIP ${display(entry.path)} (${entry.reason})`);
    for (const path of plan.paths) {
      if (!options.dryRun) removePlannedPath(plan.root, path);
      log(`${options.dryRun ? 'WOULD REMOVE' : 'REMOVED'} ${display(path)}`);
      removed += 1;
    }
  }
  log(`${options.dryRun ? 'Preview' : 'Cleanup'} complete: ${removed} path(s).`);
  return removed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log(help);
    else cleanProject(projectRoot, options);
  } catch (error) {
    console.error(`Cleanup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
