import { useRef, useState } from 'react';
import type { LoungeAttachment } from './attachments';
import type { LoungeController } from './controller';

export function useFileActions(file: LoungeAttachment, controller: LoungeController) {
  const [notice, setNotice] = useState<'' | 'client.lounge.downloadAdded' | 'client.lounge.downloadFailed'>('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const download = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setNotice('');
    try {
      if (!controller.attachments.enqueue) throw new Error('Downloads unavailable');
      await controller.attachments.enqueue(file);
      setNotice('client.lounge.downloadAdded');
    } catch { setNotice('client.lounge.downloadFailed'); }
    finally { pending.current = false; setBusy(false); }
  };
  return { notice, busy, download };
}
