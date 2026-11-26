import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfiguration, pair, unpair } from './configuration';
import { startNative } from './nativeProcess';
import { DeviceRelay } from './relay';
import { version } from '../../package.json';

const root = dirname(fileURLToPath(import.meta.url));
const [action, statePath] = process.argv.slice(2);

async function start(state: string) {
  const config = await loadConfiguration(root, state);
  const status = join(state, 'status.json');
  const temp = `${status}.${process.pid}.tmp`;
  let updates = Promise.resolve();
  const report = (stage: string, online = false) => {
    const record = { stage, online, pid: process.pid, at: new Date().toISOString() };
    updates = updates.then(async () => {
      await writeFile(temp, JSON.stringify(record), 'utf8');
      await rename(temp, status);
    }).catch(() => undefined);
  };
  let relay: DeviceRelay | undefined;
  let stopping = false;
  const native = startNative(root, join(state, 'gateway'), () => stop(1));
  function stop(code: number) {
    if (stopping) return;
    stopping = true;
    relay?.stop();
    native.close();
    report('stopped');
    void updates.finally(() => process.exit(code));
  }
  process.once('SIGINT', () => stop(0));
  process.once('SIGTERM', () => stop(0));
  try {
    await native.ready;
    relay = new DeviceRelay(config, native, version, report);
    report('starting');
    relay.start();
  } catch {
    stop(1);
  }
}

async function main() {
  if (!statePath || !['pair', 'run', 'unpair'].includes(action)) throw new Error('HANDOFF_ARGUMENTS_INVALID');
  const state = resolve(statePath);
  await mkdir(state, { recursive: true });
  if (action === 'pair') await pair(root, state);
  else if (action === 'unpair') await unpair(root, state);
  else await start(state);
}

main().catch(error => {
  const stage = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'HANDOFF_FAILED';
  console.error(stage);
  process.exitCode = 1;
});
