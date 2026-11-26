import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CONNECTION_ERRORS } from '../../shared/remote-chat/connectionErrors';
import { object } from '../../shared/remote-chat/protocol';

const MAX_CALLS = 8;
const MAX_REPLY = 20 * 1024 * 1024;
const CALL_TIMEOUT_MS = 30_000;

export interface NativeGateway {
  call<T>(operation: string, body?: Record<string, unknown>): Promise<T>;
}

interface Call {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export function startNative(root: string, state: string, stopped: () => void) {
  const runtime = join(root, 'runtime');
  const child = spawn(join(runtime, 'python', 'python.exe'),
    ['-I', '-B', join(root, 'native.py'), runtime, state], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const calls = new Map<number, Call>();
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sequence = 0;
  let alive = true;

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('NATIVE_START_TIMEOUT')), CALL_TIMEOUT_MS);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('NATIVE_EXITED')); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('NATIVE_UNAVAILABLE')); });
    reader.once('line', line => {
      clearTimeout(timer);
      if (line === '{"ready":true}') resolve();
      else reject(new Error('NATIVE_INITIALIZATION_FAILED'));
    });
  });

  function close() {
    if (!alive) return;
    alive = false;
    reader.close();
    for (const call of calls.values()) {
      clearTimeout(call.timeout);
      call.reject(new Error(CONNECTION_ERRORS.guiDisconnected));
    }
    calls.clear();
    child.stdin.end();
    const terminate = setTimeout(() => child.kill(), 2_000);
    terminate.unref();
  }

  child.once('close', () => { close(); stopped(); });
  child.stdin.on('error', close);
  reader.on('line', line => {
    if (line.length > MAX_REPLY) { close(); return; }
    let message: Record<string, unknown>;
    try { message = object(JSON.parse(line)); } catch { close(); return; }
    if (typeof message.id !== 'number') return;
    const call = calls.get(message.id);
    if (!call) return;
    calls.delete(message.id);
    clearTimeout(call.timeout);
    if (message.error) call.reject(new Error(nativeError(message.error)));
    else call.resolve(message.data);
  });

  function call<T>(operation: string, body: Record<string, unknown> = {}): Promise<T> {
    if (!alive) return Promise.reject(new Error(CONNECTION_ERRORS.guiDisconnected));
    if (calls.size >= MAX_CALLS) return Promise.reject(new Error(CONNECTION_ERRORS.guiTimeout));
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        calls.delete(id); reject(new Error(CONNECTION_ERRORS.guiTimeout));
      }, CALL_TIMEOUT_MS);
      calls.set(id, { resolve: result => resolve(result as T), reject, timeout });
      child.stdin.write(`${JSON.stringify({ ...body, id, operation })}\n`);
    });
  }
  return { ready, close, call };
}

function nativeError(code: unknown) {
  if (code === 'offline') return CONNECTION_ERRORS.guiDisconnected;
  if (code === 'busy') return CONNECTION_ERRORS.guiTimeout;
  return CONNECTION_ERRORS.configuration;
}
