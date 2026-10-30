import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import { LoungePage } from '../../../shared/lounge/LoungePage';
import { useDesktopLounge } from '../src/lounge/useDesktopLounge';
import { DashboardNavigation, type DashboardPage } from '../src/components/dashboard/DashboardNavigation';
import { translate } from '../src/i18n';
import { setGuiLanguage } from '../src/i18n/uiText';
import { useGuiLanguage } from '../src/i18n/useGuiLanguage';
import { applyThemeMode } from '../src/utils/themeMode';
import type { CloudAuthState } from '../src/types';
import { RemoteAssistance } from '../src/remoteAssistance/RemoteAssistance';
import { assistanceStore } from '../src/remoteAssistance/store';
import 'antd/dist/reset.css';
import '../src/styles.css';
import { DownloadsPage } from '../src/pages/DownloadsPage';

const parameters = new URLSearchParams(location.search);
const dark = parameters.has('dark');
applyThemeMode(dark ? 'dark' : 'light');
setGuiLanguage('zh');
declare global { interface Window { loungeFixture: {
  setLanguage: typeof setGuiLanguage; setTheme: (mode: 'light' | 'dark') => void;
} } }
const auth: CloudAuthState = { enabled: true, authenticated: true, baseUrl: 'https://lounge.test',
  userEmail: parameters.get('account') ?? 'alice@example.test', userId: 'alice',
  lastSyncAt: null, sessionExpired: false };

function Fixture() {
  const [themeMode, setThemeMode] = useState(dark ? 'dark' : 'light');
  window.loungeFixture = { setLanguage: setGuiLanguage,
    setTheme: mode => { applyThemeMode(mode); setThemeMode(mode); } };
  const language = useGuiLanguage();
  const [page, setPage] = useState<DashboardPage>('accounts');
  const lounge = useDesktopLounge(auth);
  return <ConfigProvider theme={{ algorithm: themeMode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
    <div className="app-shell sidebar-navigation-shell" style={{ gridTemplateRows: '38px 0 minmax(0, 1fr)' }}>
      <div className="window-titlebar" style={{ padding: 8 }}>Remote AI · {parameters.get('mode') ?? 'local'}</div>
      <aside className="app-sidebar"><div className="sidebar-brand">Remote AI</div>
        <DashboardNavigation page={page} onPageChange={setPage} loungeUnread={lounge.state.unread}
          loungeAvailable={auth.authenticated}
          variant="sidebar" t={(key, values) => translate(language, key, values)} />
      </aside>
      <main className="lounge-desktop-main">{page === 'lounge' ? <LoungePage controller={lounge.controller}
        onAssistance={parameters.has('assistance') ? assistanceStore.request : undefined}
        mobile={parameters.has('mobile')} onBack={() => setPage('accounts')} />
        : page === 'downloads' ? <DownloadsPage auth={auth} />
          : <div style={{ padding: 32 }} data-testid="other-page">{parameters.get('mode') ?? 'local'}</div>}</main>
    </div>
    {parameters.has('assistance') && <RemoteAssistance auth={auth} onLogin={() => {}} />}
  </ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
