import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import { ConfigProvider, theme } from 'antd';
import { TurnMessage } from '../src/pages/codexGui/TurnMessage';
import { ChatMessages } from '../../../shared/remote-chat/views/ChatMessages';
import { ApplicationTypography } from '../../../shared/appearance/ApplicationTypography';
import { guiFontStyle, saveGlobalFontSize } from '../../../shared/appearance/fontSize';
import { activityDisclosureThread } from '../../../shared/testing/activityDisclosureFixture';
import { setThemeMode } from '../../web/src/theme/preference';
import styles from '../../../shared/conversation/styles.module.less';
import '../src/pages/codexGui/remote/remoteGui.less';
import 'antd/dist/reset.css';
import '../src/styles.css';
import '../../web/src/styles.css';
import '../../../shared/remote-chat/views/chat.css';

const query = new URLSearchParams(location.search);
const mode = query.get('mode') ?? 'local';
const dark = query.has('dark');
const font = Number(query.get('font') ?? 14);
saveGlobalFontSize(font);
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
setThemeMode(dark ? 'dark' : 'light');
const algorithm = dark ? theme.darkAlgorithm : theme.defaultAlgorithm;

function Harness() {
  const [running, setRunning] = useState(query.has('running'));
  const thread = useMemo(() => activityDisclosureThread(running), [running]);
  useEffect(() => {
    const complete = () => setRunning(false);
    window.addEventListener('activity-disclosure-complete', complete);
    return () => window.removeEventListener('activity-disclosure-complete', complete);
  }, []);
  return <ConfigProvider theme={{ algorithm: mode === 'web' ? algorithm : [algorithm, theme.compactAlgorithm] }}>
    <ApplicationTypography>
      {mode === 'local' ? <main className={styles.page}
        style={{ ...guiFontStyle(font), display: 'block', height: '100dvh', overflow: 'auto' }}>
        <div className={styles.messageContent} style={{ boxSizing: 'border-box' }}>
          <TurnMessage turn={thread.turns![0]} running={running} active />
        </div>
      </main> : <main className={`chat-page ${mode === 'remote' ? 'gui-remote-workspace' : ''}`}
        style={{ ...guiFontStyle(font), height: '100dvh' }}>
        <section className="chat-conversation"><ChatMessages thread={thread} /></section>
      </main>}
    </ApplicationTypography>
  </ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
