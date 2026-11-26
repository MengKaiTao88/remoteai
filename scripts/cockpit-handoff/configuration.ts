import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { object } from '../../shared/remote-chat/protocol';

const REQUEST_TIMEOUT_MS = 15_000;
const CREDENTIAL = /^csw-desktop-service-[a-f0-9]{64}$/;

export interface Configuration {
  baseUrl: string;
  deviceId: string;
  identity: string;
  credential: string;
  name: string;
}

function vault(root: string, state: string, action: string, input?: object) {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(join(root, 'runtime', 'python', 'python.exe'),
      ['-I', '-B', join(root, 'vault.py'), action, join(state, 'binding.bin')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], timeout: REQUEST_TIMEOUT_MS });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 64 * 1024) child.kill();
    });
    child.stdin.on('error', () => reject(new Error('VAULT_PIPE_UNAVAILABLE')));
    child.once('error', () => reject(new Error('VAULT_UNAVAILABLE')));
    child.once('close', code => {
      if (code !== 0) { reject(new Error('VAULT_OPERATION_FAILED')); return; }
      try { resolve(output ? JSON.parse(output) : undefined); }
      catch { reject(new Error('VAULT_RESPONSE_INVALID')); }
    });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

export function endpoint(base: string, path: string) {
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('HTTPS_COORDINATOR_REQUIRED');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}`;
  return url;
}

async function authenticatedRequest(url: URL, token: string) {
  return fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
}

export async function loadConfiguration(root: string, state: string) {
  return await vault(root, state, 'load') as Configuration;
}

export async function pair(root: string, state: string) {
  if (existsSync(join(state, 'binding.bin'))) {
    await loadConfiguration(root, state);
    return;
  }
  const local = await vault(root, state, 'pair') as Omit<Configuration, 'credential' | 'name'> & { accessToken: string };
  const url = endpoint(local.baseUrl, `devices/${local.deviceId}/service-credential`);
  const response = await authenticatedRequest(url, local.accessToken);
  if (!response.ok) throw new Error(`DEVICE_PAIRING_HTTP_${response.status}`);
  const receipt = object(await response.json());
  const data = 'data' in receipt ? object(receipt.data) : receipt;
  if (typeof data.credential !== 'string' || !CREDENTIAL.test(data.credential)) {
    throw new Error('DEVICE_PAIRING_RESPONSE_INVALID');
  }
  const config = { baseUrl: local.baseUrl, deviceId: local.deviceId, identity: local.identity,
    name: hostname(), credential: data.credential };
  try { await vault(root, state, 'save', config); }
  catch (error) {
    await revokeCredential(config).catch(() => undefined);
    throw error;
  }
}

async function revokeCredential(configuration: Configuration) {
  const response = await authenticatedRequest(endpoint(configuration.baseUrl, 'desktop-service/revoke'),
    configuration.credential);
  if (!response.ok && response.status !== 401) throw new Error(`DEVICE_REVOKE_HTTP_${response.status}`);
}

export async function unpair(root: string, state: string) {
  const path = join(state, 'binding.bin');
  if (!existsSync(path)) return;
  await revokeCredential(await loadConfiguration(root, state));
  await rm(path);
}
