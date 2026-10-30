import { useState } from 'react';
import type { ForwardingEntry, PortForwardingService } from '../../../../../shared/port-mapping/service';
import type { MappingProtocol } from '../../../../../shared/port-mapping/settings';
import { t } from '../../i18n';

export interface MappingFormOptions {
  service: PortForwardingService;
  disabled?: boolean;
  entry?: ForwardingEntry;
  done?: () => void;
  startOnAdd?: boolean;
}

export function useMappingFormState({ service, disabled, entry, done, startOnAdd = true }: MappingFormOptions) {
  const [remoteHost, setRemoteHost] = useState(entry?.remoteHost ?? '');
  const [protocol, setProtocol] = useState<MappingProtocol>(entry?.protocol ?? 'tcp');
  const [remote, setRemote] = useState(entry ? String(entry.remotePort) : '');
  const [local, setLocal] = useState(entry ? String(entry.localPort) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const reset = () => {
    setRemoteHost(''); setRemote(''); setLocal(''); setProtocol('tcp'); setError(''); done?.();
  };
  const submit = async () => {
    if (disabled || saving) return;
    setSaving(true);
    try {
      const target = { remoteHost, remotePort: Number(remote), localPort: Number(local || remote), protocol };
      if (entry) await service.edit(entry.id, target);
      else if (startOnAdd) service.add(target.remotePort, target.localPort, target.remoteHost, protocol);
      else service.save(target);
      reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message
        : t('client.portMappingEditing.couldNotSaveTheMappingPleaseTryAgain'));
    } finally { setSaving(false); }
  };
  return { remoteHost, setRemoteHost, protocol, setProtocol, remote, setRemote, local, setLocal,
    error, saving, locked: disabled || saving, reset, submit };
}
