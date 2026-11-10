import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider, theme } from 'antd';
import { ApplicationTypography } from '../../../shared/appearance/ApplicationTypography';
import { conversation } from '../../../shared/conversation/events';
import type { Thread, Turn } from '../../../shared/conversation/types';
import { mergeHistory } from '../../../shared/remote-chat/client/history';
import { ChatMessages } from '../../../shared/remote-chat/views/ChatMessages';
import { darkColors } from '../../../shared/theme/mode';
import styles from '../../../shared/conversation/styles.module.less';
import { Messages } from '../src/pages/codexGui/Messages';
import '../../../shared/remote-chat/views/chat.css';
import '../src/pages/codexGui/remote/remoteGui.less';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'remote';
const dark = params.has('dark');
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
if (dark) for (const [role, color] of Object.entries(darkColors)) {
  document.documentElement.style.setProperty(`--app-${role}`, color);
}
const turn = (id: string, startedAt: number, question: string, answer: string): Turn => ({
  id, startedAt, status: 'completed', items: [
    { id: `${id}-question`, type: 'userMessage', content: [{ type: 'text', text: question }] },
    { id: `${id}-answer`, type: 'agentMessage', phase: 'final_answer', text: answer },
  ],
});
const oldest = turn('greeting', 100, '你好', '你好！今天需要我帮你做什么？');
const middle = turn('inspect', 200, '先检查哪些能清理', '已完成清理检查，项目文件保持完整。');
const latest = turn('continue', 300, '请继续完成刚才中断的任务。', '正在继续处理最新任务。');
const thread = (turns: Turn[]): Thread => ({ id: 'chat', cwd: '', preview: '', updatedAt: 1, turns });
const empty = thread([]);
const cached = thread([latest, oldest, middle]);

function Harness() {
  const [value, setValue] = useState(() => mergeHistory(thread([latest]), cached, empty, { retainCached: true }));
  const refresh = () => setValue(previous => mergeHistory(thread([latest]), previous, previous, { retainCached: true }));
  const algorithm = dark ? theme.darkAlgorithm : theme.defaultAlgorithm;
  const footer = <div style={{ padding: 16 }}><input aria-label="消息" placeholder="输入消息…" /></div>;
  return <ConfigProvider theme={{ algorithm: mode === 'web' ? algorithm : [algorithm, theme.compactAlgorithm] }}>
    <ApplicationTypography><App><div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: 12, display: 'flex', gap: 12 }}>
        <strong>聊天历史顺序验证</strong><button onClick={refresh}>重新同步</button>
      </header>
      <main data-turn-order={value.turns?.map(turn => turn.id).join(',')}
        className={mode === 'local' ? `${styles.page} ${styles.collapsed}`
          : mode === 'remote' ? `${styles.page} chat-page gui-remote-workspace` : 'chat-page'}
        style={{ flex: 1, minHeight: 0 }}>
        {mode === 'local' ? <div className={styles.workspace}>
          <Messages selected="chat" value={conversation(value)} active footer={footer} />
        </div> : <div className="chat-conversation">
          <ChatMessages thread={value} footer={footer} />
        </div>}
      </main>
    </div></App></ApplicationTypography>
  </ConfigProvider>;
}
const css = document.createElement('style');
css.textContent = '*{box-sizing:border-box}body{margin:0;font-family:Microsoft YaHei,sans-serif}'
  + ':root{--ink:#233329;--panel:#fff;--line:#dfe6e1;--muted:#66796d;--green:#168348;'
  + '--green-dark:#126a3b;--green-soft:#e7f4ec}'
  + ':root[data-theme=dark]{color-scheme:dark;--ink:#e6e8eb;--muted:#9298a1;--line:#2b2f33;--panel:#17191c}';
document.head.append(css);
createRoot(document.getElementById('root')!).render(<Harness />);
