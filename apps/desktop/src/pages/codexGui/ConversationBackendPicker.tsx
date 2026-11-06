import { useState } from 'react';
import { Alert, Select, Tooltip } from 'antd';
import { uiText } from '../../../../../shared/localization/uiText';
import { displayText } from '../../../../../shared/localization/uiText';
import { backendSnapshot, switchConversationBackend, type ConversationBackend } from './backendScope';
import { getGuiController } from './session';

export function ConversationBackendPicker({ disabled = false }: { disabled?: boolean }) {
  const status = backendSnapshot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = async (backend: ConversationBackend) => {
    if (busy || backend === status.backend) return;
    setBusy(true); setError('');
    try { await switchConversationBackend(backend, () => getGuiController().queueJournal.saved()); }
    catch (reason) {
      setBusy(false); setError(displayText(reason instanceof Error ? reason.message : String(reason)));
    }
  };
  return <Tooltip title={error || uiText('client.conversationBackend.switchHint')}
    styles={{ root: { maxWidth: 400 } }}>
    <span>
      <Select aria-label={uiText('client.conversationBackend.label')} size="small" variant="borderless"
        value={status.backend} loading={busy} disabled={busy || disabled} onChange={value => void change(value)}
        popupMatchSelectWidth={false} status={error ? 'error' : undefined}
        options={[
          { value: 'gui', label: uiText('client.conversationBackend.gui') },
          { value: 'official', label: uiText('client.conversationBackend.official'),
            disabled: !status.officialAvailable },
        ]} />
      {error && <Alert message={error} type="error" closable onClose={() => setError('')}
        style={{ position: 'absolute', right: 16, top: 48, maxWidth: 400, zIndex: 100 }} />}
    </span>
  </Tooltip>;
}
