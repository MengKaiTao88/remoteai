import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatComposer } from '../src/chat/ChatComposer';
import type { ComposerProps } from '../src/chat/composerProps';
import { initialChatState } from '../../../shared/remote-chat/client/types';
import { remotePromptSuggestion } from '../../../shared/remote-chat/client/promptSuggestion';
import { testModels } from '../../desktop/src/pages/codexGui/testModels';
import { setThemeMode } from '../src/theme/preference';
import 'antd-mobile/es/global';
import '../src/styles.css';

setThemeMode(new URLSearchParams(location.search).has('dark') ? 'dark' : 'light');
const state = { ...initialChatState(), ready: true, models: testModels,
  settings: { model: 'gpt-test', effort: 'high', access: 'workspace-write' as const },
  selected: { id: 'remote', cwd: '/project', preview: '', updatedAt: 1,
    turns: [{ id: 'turn', status: 'completed', items: [
      { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '方案已准备好' },
    ] }] } };
const suggestions = remotePromptSuggestion(state, async target => {
  const response = await fetch('/web/test-suggestion', { method: 'POST', body: JSON.stringify(target) });
  if (!response.ok) throw new Error('Prediction unavailable');
  return response.json();
});
const noop = () => {};
const base: Omit<ComposerProps, 'send'> = {
  suggestions, models: testModels, selection: state.settings, threadId: 'remote',
  active: true, ready: true, sending: false, running: false, settingsBusy: false, settingsError: '',
  compacting: false, compactReason: null, goalBusy: false, cwd: '/project',
  updateSettings: async () => {}, interrupt: async () => {}, compact: async () => true,
  goals: { load: async () => {}, clear: async () => true },
  contextSettings: { read: async () => ({ capacity: null }), write: async (_id, value) => value },
  catalog: { skills: [], loaded: true, loading: false, error: '', refresh: noop },
  loadFiles: async () => ({ directory: '/project', parent: null, entries: [], truncated: false }),
  loadCatalog: async () => ({ data: [], plugins: [] }), loadConversations: async () => ({ data: [], nextCursor: null }),
  readUsage: async () => ({ totalTokens: 0, estimatedCostUsd: 0, primaryRemainingPercent: null,
    primaryRemainingAggregated: false, providerEstimatedCost: null }),
  readConversationMetrics: async () => ({ totalOutputTokens: 0, totalOutputTimeMs: 0, outputRequestCount: 0 }),
  connection: { deviceName: '测试电脑', chooseDevice: noop, client: {
    read: async () => ({ running: true, choices: [], selection: { kind: 'none' } }),
    select: async selection => selection, subscribe: () => noop,
  } },
};
function Harness() {
  const [sent, setSent] = useState<string[]>([]);
  const [beats, setBeats] = useState(0);
  useEffect(() => { const timer = setInterval(() => setBeats(value => value + 1), 50);
    return () => clearInterval(timer); }, []);
  return <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100dvh' }}>
    <output aria-label="已发送">{sent.join('\n')}</output>
    <output aria-label="刷新次数" hidden>{beats}</output>
    <ChatComposer {...base} send={async input => { setSent(values => [...values, input.text]); return true; }} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
