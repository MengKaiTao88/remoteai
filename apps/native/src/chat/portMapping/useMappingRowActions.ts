import { useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import type { MessageKey } from '@remoteai/i18n';
import type { ForwardingEntry } from '../../../../../shared/port-mapping/service';

export function useMappingRowActions(entry: ForwardingEntry) {
  const [notice, setNotice] = useState<MessageKey>();
  const [menu, setMenu] = useState(false);
  const running = entry.status === 'running';
  const busy = entry.status === 'starting' || entry.status === 'stopping';
  const enabled = entry.enabled ?? (running || busy);
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(`127.0.0.1:${entry.localPort}`);
      setNotice('client.portForwarding.localAddressCopied');
    } catch { setNotice('client.chat.couldNotCopyTryAgain'); }
  };
  return { notice, menu, setMenu, running, busy, enabled, copy, canOpen: running && entry.protocol !== 'udp' };
}
