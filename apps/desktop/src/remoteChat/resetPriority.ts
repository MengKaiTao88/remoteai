import { loadAccounts, loadLocalProxyStatus, setLocalProxyAutoSwitch, setLocalProxyResetPriority } from '../api/backend';
import type { ResetPriorityStatus } from '../../../../shared/remote-chat/resetPriority';
import { RESET_PRIORITY_SET } from '../../../../shared/remote-chat/resetPriority';

/** Only routing preferences and public quota metadata cross the authenticated connection. */
export async function resetPriorityRequest(body: Record<string, unknown>): Promise<ResetPriorityStatus> {
  if (body.operation === RESET_PRIORITY_SET) {
    if (typeof body.enabled !== 'boolean') throw new Error('client.resetPriority.invalidSetting');
    if (body.setting === 'autoSwitch') await setLocalProxyAutoSwitch(body.enabled);
    else if (body.setting === 'resetPriority') await setLocalProxyResetPriority(body.enabled);
    else throw new Error('client.resetPriority.invalidSetting');
  }
  const [status, accounts] = await Promise.all([loadLocalProxyStatus(), loadAccounts()]);
  return {
    running: status.running,
    autoSwitchOnQuotaExhaustion: status.autoSwitchOnQuotaExhaustion,
    autoSwitchPriorityByReset: Boolean(status.autoSwitchPriorityByReset),
    accounts: accounts.map(account => ({
      id: account.id, priority: account.autoSwitchPriority, enabled: account.autoSwitchEnabled,
      secondaryResetsAt: account.usage.secondary?.resetsAt ?? null,
    })),
  };
}
