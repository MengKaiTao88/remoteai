import { beforeEach, expect, it, vi } from 'vitest';
import { IosLoungeDownloads } from './iosLoungeDownloads';
import type { DownloadSource, DownloadTask } from './types';
import type { DownloadClient } from '../../../../shared/remote-chat/downloads';

const mock = vi.hoisted(() => ({ files: new Map<string, Buffer>(), index: '', count: 0 }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `10000000-0000-4000-8000-${String(++mock.count).padStart(12, '0')}` }));
vi.mock('expo-sqlite/kv-store', () => ({ default: {
  getItem: async () => mock.index, setItem: async (_: string, value: string) => { mock.index = value; },
} }));
vi.mock('react-native-blob-util', () => ({ default: { fs: {
  dirs: { DocumentDir: '/app' }, exists: async (path: string) => mock.files.has(path),
  mkdir: async (path: string) => { mock.files.set(path, Buffer.alloc(0)); },
  writeFile: async (path: string, data: string) => { mock.files.set(path, Buffer.from(data, 'base64')); },
  appendFile: async (path: string, data: string) => {
    mock.files.set(path, Buffer.concat([mock.files.get(path)!, Buffer.from(data, 'base64')]));
  },
  stat: async (path: string) => ({ size: mock.files.get(path)!.length }),
  mv: async (from: string, to: string) => { mock.files.set(to, mock.files.get(from)!); mock.files.delete(from); },
  unlink: async (path: string) => {
    for (const key of mock.files.keys()) if (key === path || key.startsWith(`${path}/`)) mock.files.delete(key);
  },
} } }));

const source: DownloadSource = { owner: 'alice', deviceId: 'lounge-attachments', deviceName: 'Lounge',
  scope: 'computer', path: 'report 100%.pdf', attachment: { id: '10000000-0000-4000-8000-000000000099',
    device: '10000000-0000-4000-8000-000000000098', name: 'report 100%.pdf', mime: 'application/pdf',
    size: 700001, kind: 'file', grant: 'signed' } };
const bytes = Buffer.alloc(700001, 149);
function client(): DownloadClient {
  return { open: vi.fn(async () => ({ id: '10000000-0000-4000-8000-000000000097',
    name: source.path, size: bytes.length, revision: 'revision', mimeType: 'application/pdf' })),
  read: vi.fn(async ({ offset, length }) => ({ offset, data: bytes.subarray(offset, offset + length).toString('base64') })),
  close: vi.fn(async () => {}), browse: vi.fn(), checkSize: vi.fn() };
}
beforeEach(() => { mock.files.clear(); mock.index = ''; mock.count = 0; });

it('persists authenticated iOS downloads, restores completed files offline and removes stored bytes', async () => {
  let tasks: DownloadTask[] = [];
  const downloads = new IosLoungeDownloads(value => { tasks = value; });
  const transport = client();
  downloads.bind('alice', { ready: true, client: transport });
  const id = await downloads.enqueue(source);
  await vi.waitFor(() => expect(tasks[0].status).toBe('completed'));
  const path = decodeURI(tasks[0].uri!.slice(7));
  expect(mock.files.get(path)).toEqual(bytes);
  expect(transport.close).toHaveBeenCalledOnce();
  expect(transport.checkSize).toHaveBeenCalledWith(bytes.length, undefined);
  const restored = new IosLoungeDownloads(value => { tasks = value; });
  await restored.initialize();
  expect(tasks[0]).toMatchObject({ id, status: 'completed', received: bytes.length, source });
  await restored.remove(id);
  expect(tasks).toEqual([]); expect(mock.files.has(path)).toBe(false);
  expect(JSON.parse(mock.index)).toEqual([]);
});

it('checkpoints paused ranges, resumes after restart and isolates account connections', async () => {
  let tasks: DownloadTask[] = [];
  const downloads = new IosLoungeDownloads(value => { tasks = value; });
  const transport = client();
  const release: (() => void)[] = [];
  vi.mocked(transport.read).mockImplementation(async ({ offset, length }) => {
    if (offset > 0) await new Promise<void>(resolve => { release.push(resolve); });
    return { offset, data: bytes.subarray(offset, offset + length).toString('base64') };
  });
  downloads.bind('alice', { ready: true, client: transport });
  const id = await downloads.enqueue(source);
  await vi.waitFor(() => expect(tasks[0].received).toBe(262144));
  const paused = downloads.pause(id);
  release.forEach(resolve => resolve()); await paused;
  expect(tasks[0].status).toBe('paused');
  const restored = new IosLoungeDownloads(value => { tasks = value; });
  await restored.initialize();
  const wrongAccount = client();
  restored.bind('bob', { ready: true, client: wrongAccount });
  await restored.resume(id);
  expect(wrongAccount.open).not.toHaveBeenCalled();
  const resumed = client(); restored.bind('alice', { ready: true, client: resumed });
  await vi.waitFor(() => expect(tasks[0].status).toBe('completed'));
  expect(vi.mocked(resumed.read).mock.calls[0][0].offset).toBe(262144);
  expect(mock.files.get(decodeURI(tasks[0].uri!.slice(7)))).toEqual(bytes);
});
