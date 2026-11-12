import { useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import { GuiController } from '../src/pages/codexGui/controller';
import { modelSettingsApi } from '../src/pages/codexGui/modelSettingsApi';
import { AccessPicker } from '../src/pages/codexGui/AccessPicker';
import { ComposerBridge } from '../src/pages/codexGui/composerBridge';
import { ChatController } from '../../../shared/remote-chat/client/controller';
import { ComposerAccess } from '../../../shared/remote-chat/views/ComposerDesktopControls';
import { COMPOSER_EVENT, composerThreadId } from '../../../shared/remote-chat/composer';
import type { ConnectionEvents } from '../../../shared/remote-chat/client/connection';
import { historyDelta } from '../../../shared/remote-chat/historySync';
import { emptyQueue } from '../../../shared/remote-chat/queue';

const controller = new GuiController();
const bridge = new ComposerBridge();
let phoneEvents: ConnectionEvents;
const thread = (id: string) => ({ id, cwd: '', preview: '', updatedAt: 1, turns: [] });
const phone = new ChatController(events => {
  phoneEvents = events;
  return { start: () => { events.mode('relay'); events.ready(); }, stop: () => {},
    request: async <T,>(method: string, body?: unknown): Promise<T> => {
      const request = body as Record<string, unknown> | undefined;
      let result: unknown = { data: [], nextCursor: null };
      if (method === 'connect') result = [];
      if (request?.operation === 'models') {
        const composer = await bridge.read(composerThreadId(request.threadId));
        result = { data: composer.models, nextCursor: null, composer };
      }
      if (request?.operation === 'composerSet') result = await bridge.update(request.settings, composerThreadId(request.threadId));
      if (request?.operation === 'syncHistory') result = historyDelta(thread(String(request.threadId)));
      if (request?.operation === 'queueRead') result = emptyQueue();
      return result as T;
    } };
});
const remote = new URLSearchParams(location.search).has('remote');
function Harness() {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const phoneState = useSyncExternalStore(listener => phone.subscribe(listener), () => phone.snapshot());
  useEffect(() => {
    const stop = controller.modelSettings.start(modelSettingsApi);
    const detach = bridge.attach(controller);
    const unlisten = bridge.subscribe(snapshot => phoneEvents?.event({ method: COMPOSER_EVENT, params: snapshot }));
    void controller.connect().then(() => { if (remote) phone.start(); });
    return () => { phone.stop(); unlisten(); detach(); stop(); controller.dispose(); };
  }, []);
  return <ConfigProvider><main style={{ maxWidth: 700, margin: '32px auto', padding: 16 }}>
    <nav style={{ display: 'flex', gap: 16 }}>{['a', 'b'].map(id =>
      <button key={id} onClick={() => { if (remote) void phone.select(thread(id)); else void controller.select(id); }}>对话 {id}</button>)}</nav>
    <h2>会话权限同步验证</h2><p>当前对话：{(remote ? phoneState.selected?.id : state.selected) ?? '新对话'}</p>
    <section style={{ background: 'white', padding: 20, border: '1px solid #ddd', borderRadius: 16 }}>
      <p>描述任务…</p>
      {remote ? <ComposerAccess selection={phoneState.settings} settingsBusy={phoneState.settingsBusy}
        accessUpdate={phoneState.accessUpdate}
        updateSettings={settings => phone.setSettings(settings)} beforeOpen={() => {}} />
        : <AccessPicker value={state.settings.access} disabled={Boolean(state.modelSettingsLoading)}
          pending={controller.modelSettings.accessUpdate(state.selected) === 'nextTurn'}
          onChange={access => controller.settings({ access })} />}
    </section>
    {(state.error || phoneState.settingsError) && <p role="alert">{state.error || phoneState.settingsError}</p>}
  </main></ConfigProvider>;
}
document.body.style.cssText = 'margin:0;font-family:sans-serif;background:#f8f9f9';
createRoot(document.getElementById('root')!).render(<Harness />);
