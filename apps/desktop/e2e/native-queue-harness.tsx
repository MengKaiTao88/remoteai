import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import { ApplicationTypography } from '../../../shared/appearance/ApplicationTypography';
import { CodexAppearance } from '../../../shared/appearance/CodexAppearance';
import { saveGlobalFontSize } from '../../../shared/appearance/fontSize';
import { setInterfaceLanguage } from '../../../shared/localization/interfaceLanguage';
import { ChatQueue } from '../../../shared/remote-chat/views/ChatQueue';
import { QueuedMessages } from '../src/pages/codexGui/QueuedMessages';
import type { MessageQueue } from '../src/pages/codexGui/messageQueue';
import type { QueueMessage } from '../../../shared/remote-chat/queue';
import { QueueJournal } from '../src/pages/codexGui/queueJournal';
import type { QueuedMessage } from '../../../shared/conversation/types';
import 'antd/dist/reset.css';

const parameters = new URLSearchParams(location.search);
const mode = parameters.get('mode') ?? 'local';
if (mode === 'web') await import('../../web/src/styles.css');
else await import('../src/styles.css');
const dark = parameters.has('dark');
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
setInterfaceLanguage('zh');
saveGlobalFontSize(parameters.has('large') ? 20 : 14);
const calls: string[] = [];
const queue = Object.fromEntries(['flush', 'move', 'remove', 'steer'].map(name => [name, () => calls.push(name)]));
const native = [{ id: 'owner-first', text: '请在当前任务之后检查清理规则。', imageCount: 0 },
  { id: 'owner-second', text: '再检查一次历史记录。', imageCount: 0 }];
let restored: QueuedMessage[] = [];
await new QueueJournal({ reviewRestoredFailures: true,
  read: async () => ({ revision: 1, threads: { chat: [{ id: 'local', text: native[0].text, images: [], skills: [],
    model: '', effort: '', access: 'read-only', error: '发送失败，请重试。' }] } }),
  save: async snapshot => snapshot,
}, snapshot => { restored = snapshot.chat; }, () => {}).restore();

function Harness() {
  const [items, setItems] = useState(native);
  Object.assign(window, { queueFixture: { clear: () => setItems([]), calls } });
  const messages: QueueMessage[] = [...items.map(item => ({ ...item, official: true, busy: false,
    attachmentCount: 0 })), ...restored.map(item => ({ id: item.id, text: item.text, imageCount: 0,
    attachmentCount: 0, busy: false, error: item.error }))];
  return <ConfigProvider theme={{ algorithm: mode === 'web' ? (dark ? theme.darkAlgorithm : theme.defaultAlgorithm)
    : [dark ? theme.darkAlgorithm : theme.defaultAlgorithm, theme.compactAlgorithm] }}>
    <ApplicationTypography><CodexAppearance><main style={{ padding: 20, minHeight: '100dvh',
      background: dark ? '#181818' : '#ffffff', color: dark ? '#eeeeee' : '#181818' }}>
      {mode === 'local' ? <QueuedMessages threadId="chat" nativeQueue={items} messages={restored}
        running connected queue={queue as unknown as MessageQueue} editDisabled={false} onEdit={() => {}} />
        : <ChatQueue messages={messages} running disabled={false} editDisabled={false}
          act={async operation => { calls.push(operation); }} take={async () => undefined} edit={async () => {}} />}
    </main></CodexAppearance></ApplicationTypography>
  </ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
