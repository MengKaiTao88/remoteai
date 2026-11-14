import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import { ApplicationTypography } from '../../../shared/appearance/ApplicationTypography';
import { saveGlobalFontSize } from '../../../shared/appearance/fontSize';
import { setInterfaceLanguage } from '../../../shared/localization/interfaceLanguage';
import { initialChatState } from '../../../shared/remote-chat/client/types';
import { applyChatEvent } from '../../../shared/remote-chat/client/events';
import { ChatApproval } from '../../../shared/remote-chat/views/ChatApproval';
import { initialState } from '../src/pages/codexGui/preferences';
import { conversation, reduceEvent } from '../../../shared/conversation/events';
import { Approvals } from '../src/pages/codexGui/Approvals';
import type { GuiEvent, Thread } from '../../../shared/conversation/types';
import 'antd/dist/reset.css';
import '../../../shared/remote-chat/views/chat.css';
import '../../../shared/remote-chat/views/composer.css';

const query = new URLSearchParams(location.search);
const mode = query.get('mode') ?? 'local';
const dark = query.has('dark');
if (mode === 'web') await import('../../web/src/styles.css');
else await import('../src/styles.css');
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
for (const [key, value] of Object.entries({ '--app-canvas': dark ? '#181818' : '#f5f5f5',
  '--app-surface': dark ? '#242424' : '#fff', '--app-ink': dark ? '#eee' : '#181818',
  '--app-border': dark ? '#424242' : '#ddd', '--app-muted': dark ? '#aaa' : '#666' })) {
  document.documentElement.style.setProperty(key, value);
}
saveGlobalFontSize(query.has('large') ? 20 : 14);
setInterfaceLanguage('zh');
const thread: Thread = { id: 'question-chat', cwd: '', updatedAt: 1, preview: '',
  turns: [{ id: 'running', status: 'inProgress', items: [] }] };
const prompt: GuiEvent = { id: 'bridge:question-chat:async:old:question', method: 'item/tool/requestUserInput',
  params: { threadId: thread.id, turnId: null, questions: [{ id: 'question',
    question: '现在顶栏是否显示完整，并且没有挤压或遮挡？',
    options: ['四项都有，显示正常', '有显示，但排版有问题', '有项目没显示'].map(label => ({ label })) }] } };
const gui = initialState(); gui.conversations[thread.id] = conversation(thread); gui.selected = thread.id;
const chat = initialChatState(); chat.selected = thread; chat.ready = true;
const calls: string[] = [];

function Harness() {
  const [local, setLocal] = useState(() => reduceEvent(gui, prompt));
  const [remote, setRemote] = useState(() => applyChatEvent(chat, prompt));
  Object.assign(window, { questionResolution: { calls, receive: (event: GuiEvent) => {
    setLocal(value => reduceEvent(value, event));
    setRemote(value => applyChatEvent(value, event));
  } } });
  const approvals = mode === 'local' ? local.approvals : remote.approvals;
  return <ConfigProvider theme={{ algorithm: mode === 'web' ? (dark ? theme.darkAlgorithm : theme.defaultAlgorithm)
    : [dark ? theme.darkAlgorithm : theme.defaultAlgorithm, theme.compactAlgorithm] }}>
    <ApplicationTypography><main style={{ padding: 20, minHeight: '100dvh',
      background: dark ? '#181818' : '#fff', color: dark ? '#eee' : '#181818' }}>
      <h2>提问状态同步验证</h2><p>电脑端处理后，其他页面自动收起旧提问。</p>
      {mode === 'local' ? <Approvals events={approvals} controller={{ respond: async () => { calls.push('respond'); } }} />
        : approvals.map(event => <ChatApproval key={event.id} event={event} ready
          respond={async () => { calls.push('respond'); }} />)}
      {!approvals.length && <p data-testid="resolved">旧提问已同步结束</p>}
    </main></ApplicationTypography>
  </ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
