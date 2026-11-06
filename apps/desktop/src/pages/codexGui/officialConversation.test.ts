import { afterEach, expect, it, vi } from 'vitest';
import { guiApi } from '../../../../../shared/conversation/api';
import { backendSnapshot } from './backendScope';
import { activateOfficialConversation } from './officialConversation';

vi.mock('../../../../../shared/conversation/api', () => ({ guiApi: { request: vi.fn() } }));
vi.mock('./backendScope', () => ({ backendSnapshot: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it('keeps GUI history selection passive', async () => {
  vi.mocked(backendSnapshot).mockReturnValue({ backend: 'gui', officialAvailable: true });
  await activateOfficialConversation('thread');
  expect(guiApi.request).not.toHaveBeenCalled();
});

it('attaches an explicitly selected official conversation before loading its composer', async () => {
  vi.mocked(backendSnapshot).mockReturnValue({ backend: 'official', officialAvailable: true });
  await activateOfficialConversation('thread');
  expect(guiApi.request).toHaveBeenCalledWith({ operation: 'resume', threadId: 'thread',
    access: 'read-only', summaryOnly: true });
});

it('reports an owner activation failure instead of treating the conversation as ready', async () => {
  vi.mocked(backendSnapshot).mockReturnValue({ backend: 'official', officialAvailable: true });
  vi.mocked(guiApi.request).mockRejectedValue(new Error('owner unavailable'));
  await expect(activateOfficialConversation('thread')).rejects.toThrow('owner unavailable');
});
