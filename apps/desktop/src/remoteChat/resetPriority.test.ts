import { beforeEach, expect, it, vi } from 'vitest';
import { resetPriorityRequest } from './resetPriority';
import { RESET_PRIORITY_READ, RESET_PRIORITY_SET } from '../../../../shared/remote-chat/resetPriority';

const backend = vi.hoisted(() => ({
  loadAccounts: vi.fn(), loadLocalProxyStatus: vi.fn(),
  setLocalProxyAutoSwitch: vi.fn(), setLocalProxyResetPriority: vi.fn(),
}));
vi.mock('../api/backend', () => backend);

beforeEach(() => {
  vi.clearAllMocks();
  backend.loadLocalProxyStatus.mockResolvedValue({ running: true, autoSwitchOnQuotaExhaustion: true,
    autoSwitchPriorityByReset: true, hasLanApiKey: true, privateSecret: 'never-send' });
  backend.loadAccounts.mockResolvedValue([{ id: 'a', autoSwitchPriority: 1, autoSwitchEnabled: true,
    email: 'private@example.com', privateDetails: { password: 'never-send' },
    usage: { secondary: { resetsAt: 1000 } } }]);
});

it('returns effective priorities without private account details or proxy secrets', async () => {
  expect(await resetPriorityRequest({ operation: RESET_PRIORITY_READ })).toEqual({
    running: true, autoSwitchOnQuotaExhaustion: true, autoSwitchPriorityByReset: true,
    accounts: [{ id: 'a', priority: 1, enabled: true, secondaryResetsAt: 1000 }],
  });
});

it('changes only the requested preference and returns the confirmed status', async () => {
  await resetPriorityRequest({ operation: RESET_PRIORITY_SET, setting: 'resetPriority', enabled: true });
  expect(backend.setLocalProxyResetPriority).toHaveBeenCalledWith(true);
  expect(backend.setLocalProxyAutoSwitch).not.toHaveBeenCalled();
});

it('rejects malformed remote changes without changing preferences', async () => {
  await expect(resetPriorityRequest({ operation: RESET_PRIORITY_SET, setting: 'resetPriority', enabled: 'true' }))
    .rejects.toThrow('client.resetPriority.invalidSetting');
  await expect(resetPriorityRequest({ operation: RESET_PRIORITY_SET, setting: 'arbitrary', enabled: true }))
    .rejects.toThrow('client.resetPriority.invalidSetting');
  expect(backend.setLocalProxyResetPriority).not.toHaveBeenCalled();
  expect(backend.setLocalProxyAutoSwitch).not.toHaveBeenCalled();
});

it('propagates failed writes so clients do not claim success', async () => {
  backend.setLocalProxyResetPriority.mockRejectedValueOnce(new Error('disk full'));
  await expect(resetPriorityRequest({ operation: RESET_PRIORITY_SET, setting: 'resetPriority', enabled: true }))
    .rejects.toThrow('disk full');
  expect(backend.loadAccounts).not.toHaveBeenCalled();
});
