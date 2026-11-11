# Project cleanup

Run these commands from the project root. Node.js and Git are required; no additional packages are needed.

```sh
npm run clean:preview                  # Show what would be removed
npm run clean                          # Remove build output and AI scratch files
npm run clean -- --build               # Only build output and test reports
npm run clean -- --ai                  # Only AI scratch files
npm run clean -- --include-submodules --dry-run
npm run clean -- --include-submodules  # Include initialized submodules
npm run test:clean                     # Run cleanup safety tests in temporary repositories
npm run clean:task                     # Remove completed packaging scratch; retain reusable caches
npm run clean:retired -- --checkout /absolute/retired-checkout --dry-run
```

## Default task-completion policy

The selected policy balances speed and disk usage. Keep the primary checkout and its installed dependencies
and Cargo caches. New tasks in that checkout reuse the same outputs; a new conversation does not need a new
clone, `npm ci`, or a full cache reset.

`npm run build:app` (including platform variants) automatically removes
`apps/desktop/src-tauri/target/frontend-dist` only after the Tauri CLI finishes successfully. An exclusive
packaging lock prevents a second packaging run from using the same staging directory. Failed builds retain
their frontend inputs. If an interrupted process leaves a lock, verify that its owner has stopped before
removing the lock; do not delete it to bypass an active build.

`npm run clean:task` provides the same narrow cleanup at task completion. It retains `target/debug`,
`target/release`, dependencies, executables, installer bundles, runtime resources, test reports, screenshots,
recovery files and all existing `.artifacts` / `.codex-tmp` contents. It does not mean that every temporary
file has been reviewed. Preserve needed evidence and review task-owned scratch separately.

For an inactive temporary checkout, first stop its tasks/builds and inspect ownership. Preview with
`npm run clean:retired -- --checkout "C:\path\to\retired-checkout" --dry-run`, then repeat without
`--dry-run` to remove only allowlisted Rust `target` directories in that checkout. The path must be an absolute
Git repository root outside the primary checkout. Source, Git history, stashes, dependencies, installers stored
outside `target`, recovery materials and other scratch remain intact. Preserve any deliverables that were
stored inside a retired `target` before removing it. The command never deletes the checkout itself.

The retired command is a task-owner action, not a background scan or a deletion based only on age. Broad
`npm run clean` / `--build` / `--ai` commands below remain manual cleanup tools and are not post-build hooks.

Stop development servers, builds, tests and AI tasks before running a cleanup that deletes files.
Preview is safe to use while inspecting the checkout. Deleted scratch files, including screenshots and logs,
cannot be recovered by this script; copy anything you need to keep elsewhere first.

The default scope is the parent repository. The build allowlist includes root `dist` and `.nx`, desktop and
website bundles, website prerender output, Rust targets, browser test output and the two Rust test harnesses.
AI cleanup checks `.codex-tmp`, `.codex-tmp-*`, `.artifacts` and `.tmp` directly under the project root,
`apps/desktop`, `apps/website` and `scripts`. A path must also be ignored by Git to be eligible; unignored
scratch directories are reported and retained. The complete build allowlist lives in
`scripts/lib/clean-project-targets.mjs`.

`--include-submodules` adds known build and scratch output in initialized admin, admin UI, Coze, native,
web, i18n and shared submodules. Missing submodules are skipped. Each child uses its own Git index, HEAD and
ignore rules. The script does not initialize submodules, change revisions or regenerate dependency snapshots.

Source files, build scripts, tracked output, `node_modules`, `.env`, authentication files, `.worktrees`,
`vendor` and `.workspace` outside the selected disposable directories are preserved. A candidate containing
tracked files is retained in full, including files staged for deletion that still exist on disk. Nested Git
repositories, bare repositories, worktrees, symbolic links and directory junctions are retained; other scratch
files beside them can still be removed. The script never follows these links or accepts arbitrary cleanup paths.
It does not sweep all ignored files or delete loose logs outside the allowlisted scratch directories.

The command reports removed paths and skipped paths with reasons. A Git, permission or filesystem error stops
the command with a nonzero exit code. If deletion has already started, earlier successful removals remain in effect.
