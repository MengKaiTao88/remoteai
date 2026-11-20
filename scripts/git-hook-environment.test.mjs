import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

function createHookFixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'remoteai-hook-environment-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const environment = { ...process.env };
  const localVariables = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n');
  for (const name of localVariables) delete environment[name.trim()];
  const root = join(temporary, 'caller');
  const fixture = join(temporary, 'fixture.git');
  const bin = join(temporary, 'bin');
  mkdirSync(bin);
  const git = (args, env = environment) => execFileSync('git', args, {
    cwd: root, env, encoding: 'utf8', stdio: 'pipe',
  });
  execFileSync('git', ['init', '--quiet', root], { env: environment, stdio: 'pipe' });
  mkdirSync(join(root, '.hooks'));
  const hook = readFileSync(new URL('../.husky/pre-commit', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  writeFileSync(join(root, '.hooks/pre-commit'), `#!/bin/sh\n${hook}`, { mode: 0o755 });
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\n[ "$*" = "run check" ] || exit 2\ngit init --quiet --bare "$HOOK_TEST_FIXTURE"\n', { mode: 0o755 });
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const separator = process.platform === 'win32' ? ';' : ':';
  const hookEnvironment = { ...environment, [pathKey]: `${bin}${separator}${environment[pathKey]}`,
    GIT_DIR: resolve(root, '.git'), GIT_WORK_TREE: root, GIT_INDEX_FILE: resolve(root, '.git/index'),
    HOOK_TEST_FIXTURE: fixture };
  const commit = (...args) => git(['-c', 'core.hooksPath=.hooks', '-c', 'user.name=Hook Test',
    '-c', 'user.email=hook@example.invalid', 'commit', '-qm', 'verify pre-commit check', ...args], hookEnvironment);
  return { root, fixture, environment, git, commit };
}

test('Markdown-only commits use the actual commit index even with other changes staged', t => {
  const { root, fixture, git, commit } = createHookFixture(t);
  mkdirSync(join(root, 'docs', 'agents'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), 'Initial rules\n');
  writeFileSync(join(root, 'docs', 'agents', 'build checks.md'), 'Build checks\n');
  git(['add', 'AGENTS.md', 'docs']);
  commit();
  assert.equal(existsSync(fixture), false);

  writeFileSync(join(root, 'AGENTS.md'), 'Updated rules\n');
  writeFileSync(join(root, 'source.rs'), 'fn main() {}\n');
  git(['add', 'source.rs']);
  commit('--only', '--', 'AGENTS.md');
  assert.equal(git(['show', 'HEAD:AGENTS.md']), 'Updated rules\n');
  assert.equal(git(['diff', '--cached', '--name-only']).trim(), 'source.rs');
  assert.equal(existsSync(fixture), false);
});

test('staged Markdown with trailing whitespace fails the lightweight check', t => {
  const { root, fixture, git, commit } = createHookFixture(t);
  writeFileSync(join(root, 'AGENTS.md'), 'Extra whitespace \n');
  git(['add', 'AGENTS.md']);
  assert.throws(commit, /trailing whitespace/);
  assert.equal(existsSync(fixture), false);
});

test('mixed commits run project checks with Git environment isolation', t => {
  const { root, fixture, environment, git, commit } = createHookFixture(t);
  writeFileSync(join(root, 'AGENTS.md'), 'Project rules\n');
  writeFileSync(join(root, 'source.txt'), 'retained source\n');
  git(['add', 'AGENTS.md', 'source.txt']);
  commit();
  assert.equal(git(['rev-parse', '--is-bare-repository']).trim(), 'false');
  assert.equal(git(['show', 'HEAD:source.txt']), 'retained source\n');
  assert.equal(execFileSync('git', ['--git-dir', fixture, 'rev-parse', '--is-bare-repository'],
    { env: environment, encoding: 'utf8' }).trim(), 'true');
});
