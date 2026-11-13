import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import { ProxyTopbarActions } from '../src/components/dashboard/ProxyTopbarActions';
import { AutoSwitchPriorityInput } from '../src/components/accounts/AccountTableParts';
import type { useProviderManager } from '../src/hooks/useProviderManager';
import type { Account } from '../src/types';
import { DEMO_ACCOUNTS } from '../src/demo';
import { translate, type Translate } from '../src/i18n';
import { ResetPriorityEditor } from '../../web/src/accounts/ResetPrioritySettings';
import type { ResetPriorityClient, ResetPriorityStatus } from '../../../shared/remote-chat/resetPriority';
import '../../web/src/accounts/styles.css';

const t: Translate = (key, values) => translate('zh', key, values);
const mode = new URLSearchParams(location.search).get('mode') ?? 'desktop-local';
await import('antd/dist/reset.css');
if (mode === 'desktop-local') await import('../src/styles.css');
else {
  await import('antd-mobile/es/global');
  await import('../../web/src/styles.css');
}
const sample = DEMO_ACCOUNTS.slice(0, 3).map((account, index) => ({ ...account,
  autoSwitchPriority: [8, -2, 3][index] ?? 0,
  usage: { ...account.usage, secondary: { ...account.usage.secondary!,
    resetsAt: Math.floor(Date.now() / 1000) + [300, 100, 200][index] } },
}));
function Fixture() {
  const [automatic, setAutomatic] = useState(false);
  const [custom, setCustom] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState(sample);
  const toggle = async (value: boolean) => {
    setBusy(true);
    await new Promise(resolve => setTimeout(resolve, 80));
    setAutomatic(value);
    if (value) setCustom(true);
    setBusy(false);
  };
  const ranked = accounts.map((account, index) => ({ ...account,
    autoSwitchPriority: automatic && custom && enabled ? [3, 1, 2][index] : account.autoSwitchPriority,
  }));
  const manager = { localProxy: { running: true, autoSwitchOnQuotaExhaustion: enabled,
    customAutoSwitchPriorityEnabled: custom, autoSwitchPriorityByReset: automatic }, proxyBusy: busy,
    setProxyResetPriority: toggle, setProxyAutoSwitch: async (value: boolean) => setEnabled(value),
    setProxyCustomPriority: async (value: boolean) => { setCustom(value); if (!value) setAutomatic(false); },
  } as ReturnType<typeof useProviderManager>;
  const client = useMemo<ResetPriorityClient>(() => {
    let value: ResetPriorityStatus = { running: true, autoSwitchOnQuotaExhaustion: true,
      autoSwitchPriorityByReset: false, accounts: sample.map(account => ({ id: account.id,
        priority: account.autoSwitchPriority, enabled: true, secondaryResetsAt: account.usage.secondary!.resetsAt! })) };
    return { read: async () => value, set: async change => {
      value = { ...value, [change.setting === 'autoSwitch' ? 'autoSwitchOnQuotaExhaustion'
        : 'autoSwitchPriorityByReset']: change.enabled };
      value.accounts = value.accounts.map((account, index) => ({ ...account,
        priority: value.autoSwitchPriorityByReset ? [3, 1, 2][index] : sample[index].autoSwitchPriority }));
      return value;
    } };
  }, []);
  return <ConfigProvider theme={{ algorithm: [theme.defaultAlgorithm, theme.compactAlgorithm] }}>
    <main style={{ margin: '24px auto', maxWidth: 1000, padding: 24, fontFamily: 'sans-serif' }}>
      <h1>{mode === 'web-desktop' ? '账号' : '账户管理'}</h1>
      {mode === 'desktop-local' ? <>
        <ProxyTopbarActions manager={manager} onOpenSessions={() => {}} t={t} />
        <table style={{ width: '100%', marginTop: 24, borderSpacing: 16 }}><thead><tr>
          <th>账号</th><th>次用量重置</th><th>{automatic ? '自动切换优先级（自动）' : '自动切换优先级'}</th>
        </tr></thead><tbody>{ranked.map(account => <tr key={account.id}><td>{account.email}</td>
          <td>{new Date(account.usage.secondary!.resetsAt! * 1000).toLocaleString()}</td><td>
            <AutoSwitchPriorityInput account={account} disabled={automatic} t={t} onSave={async (id, priority) => {
              setAccounts(current => current.map(item => item.id === id ? { ...item, autoSwitchPriority: priority } : item));
              return true;
            }} />
          </td></tr>)}</tbody></table>
      </> : <div className="reset-priority-settings"><ResetPriorityEditor client={client} connected
        accounts={sample} privateMode={false} /></div>}
    </main>
  </ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
