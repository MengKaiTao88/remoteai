import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ConfigProvider } from 'antd';
import { ChatMarkdown } from '../../../shared/remote-chat/views/ChatMarkdown';
import { ChatQueue } from '../../../shared/remote-chat/views/ChatQueue';
import { RichText } from '../../../shared/conversation/RichText';
import '../../../shared/remote-chat/views/chat.css';
import '../../../shared/remote-chat/views/messages.css';
import '../../../shared/remote-chat/views/desktopMessages.css';
import 'antd/dist/reset.css';

const sample = `| Conversation/task | Files | Completed work | Remaining work or uncertainties | Verification | Reason not committed and next steps |
| --- | --- | --- | --- | --- | --- |
| 既有聊天、Git 面板等其他任务 | 文件清单 | 保留现有改动和暂存状态 | 无法通过当前工具完整核实其原会话归属与完成度 | 当前组合代码通过项目检查 | 归属与验收未确认，保留待按原任务分别审查、提交 |`;
const mode = new URLSearchParams(location.search).get('mode');
function Fixture() {
  const [queued, setQueued] = useState(true);
  return <ConfigProvider><main style={{ padding: 16, width: '100%', minWidth: 0,
    '--app-border': '#dfe5e1', '--app-surface': '#fff', '--app-ink': '#17211b',
  } as import('react').CSSProperties}>
    {mode === 'desktop-local' ? <RichText text={sample} /> : <ChatMarkdown text={sample}
      desktop={mode === 'desktop-remote'} />}
    <ChatQueue messages={queued ? [{ id: 'failed-draft', text: 'test draft', imageCount: 0,
      attachmentCount: 0, busy: false, error: 'client.errorsCodexGui.codexDisconnectedReconnectToContinue' }] : []}
      running={false} disabled={false} editDisabled={false} take={async () => undefined}
      edit={async () => {}} act={async () => { setQueued(false); }} />
  </main></ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
