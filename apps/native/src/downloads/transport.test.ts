import { expect, it, vi } from 'vitest';
import { forwardDownloadRequest } from './transport';
import type { DownloadNative, DownloadRequest } from './types';
import type { DownloadClient } from '../../../../shared/remote-chat/downloads';
import { BulkError } from '../../../../shared/remote-chat/bulkLimits';

const source = { scope: 'computer' as const, owner: 'account', deviceId: 'pc', deviceName: 'PC', path: 'F:/app.apk' };
const request: DownloadRequest = { requestId: 'request', taskId: 'job', source,
  operation: 'open', remoteId: '', offset: 0, length: 0 };
function setup() {
  const client: DownloadClient = { open: vi.fn(), read: vi.fn(),
    close: vi.fn().mockResolvedValue(null), browse: vi.fn() };
  const native: DownloadNative = { accept: vi.fn().mockResolvedValue(true), list: vi.fn(), enqueue: vi.fn(),
    pause: vi.fn(), resume: vi.fn(), delete: vi.fn(), share: vi.fn(), connection: vi.fn(),
    previewText: vi.fn(), previewUri: vi.fn(), exportImage: vi.fn(), discardPreview: vi.fn() };
  return { client, native };
}

it('preserves attachment authorization when opening a persisted lounge task', async () => {
  const { client, native } = setup();
  const attachment = { id: 'file', device: 'sender', name: 'invoice.pdf', size: 5,
    mime: 'application/pdf', kind: 'file' as const, grant: 'signed' };
  vi.mocked(client.open).mockResolvedValue({ id: 'handle', name: attachment.name, size: 5, mimeType: attachment.mime });
  await forwardDownloadRequest({ request: { ...request, source: { ...source, path: attachment.name, attachment } },
    client, native });
  expect(client.open).toHaveBeenCalledWith(expect.objectContaining({ attachment }), expect.anything());
});

it('preserves the commit when opening a patch from a native download task', async () => {
  const { client, native } = setup();
  vi.mocked(client.open).mockResolvedValue({ id: 'handle', name: 'commit.patch', size: 5, mimeType: 'text/plain' });
  const patchSource = { ...source, scope: 'project' as const, cwd: '/repo',
    path: 'commit.patch', gitCommit: 'a'.repeat(40) };
  await forwardDownloadRequest({ request: { ...request, source: patchSource }, client, native });
  expect(client.open).toHaveBeenCalledWith({ transferId: 'job', scope: 'project', cwd: '/repo',
    path: 'commit.patch', gitCommit: 'a'.repeat(40) },
  expect.objectContaining({ signal: expect.any(AbortSignal), progress: expect.any(Function) }));
});

it('forwards compression progress to the same pending native request', async () => {
  const { client, native } = setup();
  native.preparationProgress = vi.fn().mockResolvedValue(undefined);
  const progress = { phase: 'compressing' as const, processedBytes: 5, totalBytes: 10,
    completedFiles: 0, totalFiles: 1 };
  vi.mocked(client.open).mockImplementation(async (_options, controls) => {
    await controls?.progress?.(progress);
    return { id: 'handle', name: 'folder.zip', size: 5, mimeType: 'application/zip' };
  });
  await forwardDownloadRequest({ request, client, native });
  expect(native.preparationProgress).toHaveBeenCalledWith(request.requestId, JSON.stringify(progress));
  expect(native.accept).toHaveBeenCalledWith(request.requestId, expect.stringContaining('folder.zip'), false);
});

it('closes a late remote handle when pause or deletion won the race', async () => {
  const { client, native } = setup();
  vi.mocked(client.open).mockResolvedValue({ id: 'handle', name: 'app.apk', size: 5, mimeType: 'binary' });
  vi.mocked(native.accept).mockResolvedValue(false);
  await forwardDownloadRequest({ request, client, native });
  expect(client.close).toHaveBeenCalledWith('job', 'handle');
});

it('forwards resumed offsets without decoding the base64 payload in JS', async () => {
  const { client, native } = setup();
  const chunk = { offset: 262144, data: 'AA==' };
  vi.mocked(client.read).mockResolvedValue(chunk);
  await forwardDownloadRequest({ request: { ...request, operation: 'read', remoteId: 'handle',
    offset: chunk.offset, length: 1 }, client, native });
  expect(client.read).toHaveBeenCalledWith({ threadId: 'job', id: 'handle', offset: chunk.offset, length: 1 });
  expect(native.accept).toHaveBeenCalledWith('request', JSON.stringify(chunk), false);
});

it('reports disconnected sources to the native task instead of using another computer', async () => {
  const { native } = setup();
  await forwardDownloadRequest({ request, native });
  expect(native.accept).toHaveBeenCalledWith('request', null, true);
});

it('reports transport failure and keeps it isolated to its task', async () => {
  const { client, native } = setup();
  vi.mocked(client.open).mockRejectedValue(new Error('offline'));
  await forwardDownloadRequest({ request, client, native });
  expect(native.accept).toHaveBeenCalledWith('request', null, true);
});

it.each(['SOURCE_CHANGED', 'PATH_UNAVAILABLE'] as const)('preserves the authenticated download failure %s', async code => {
  const { client, native } = setup();
  vi.mocked(client.open).mockRejectedValue(new BulkError(code));
  await forwardDownloadRequest({ request, client, native });
  expect(native.accept).toHaveBeenCalledWith('request', JSON.stringify({ code }), true);
});

it('preserves file access failure instead of reporting a broken connection', async () => {
  const { client, native } = setup();
  vi.mocked(client.open).mockRejectedValue(new Error('文件暂时无法下载，请确认文件仍在当前项目中。'));
  await forwardDownloadRequest({ request, client, native });
  expect(native.accept).toHaveBeenCalledWith('request', JSON.stringify({ code: 'FILE_UNAVAILABLE' }), true);
});
