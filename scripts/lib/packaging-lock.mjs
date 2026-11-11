import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safePath } from './clean-project-safety.mjs';

const owners = new Map();
const lockPath = root => join(root, 'apps/desktop/src-tauri/target/.remoteai-packaging.lock');

export function assertPackagingCleanupAvailable(root) {
  const lock = lockPath(root);
  if (existsSync(lock) && readFileSync(lock, 'utf8') !== owners.get(lock)) {
    throw new Error('Packaging still owns the temporary frontend; wait before task cleanup.');
  }
}

/** Serialize packaging so success cleanup cannot remove another packaging run's frontend. */
export function acquirePackagingLock(root) {
  root = realpathSync(root);
  const target = 'apps/desktop/src-tauri/target';
  let parent = root;
  for (const part of target.split('/')) {
    parent = join(parent, part);
    mkdirSync(parent, { recursive: true });
    if (!safePath(root, parent)) throw new Error('Packaging output cannot be a directory link.');
  }
  const lock = lockPath(root);
  const token = `${process.pid}:${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(lock, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another packaging run owns the output. Preserve its lock and wait.');
    throw error;
  }
  writeFileSync(descriptor, token);
  closeSync(descriptor);
  owners.set(lock, token);
  let released = false;
  return () => {
    if (released) return;
    // Never remove a replacement lock after an interrupted owner or external file change.
    if (existsSync(lock) && readFileSync(lock, 'utf8') === token) unlinkSync(lock);
    owners.delete(lock);
    released = true;
  };
}
