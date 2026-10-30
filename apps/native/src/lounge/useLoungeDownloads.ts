import { useEffect } from 'react';
import { downloadManager, downloadOwner } from '../downloads/manager';
import type { AuthSession } from '../types';
import { t } from '../i18n';
import type { LoungeController } from '../../../../shared/lounge/controller';
import { loungeDownloadClient, LOUNGE_DOWNLOAD_DEVICE } from '../../../../shared/lounge/downloadClient';

export function useLoungeDownloads(controller: LoungeController, session: AuthSession | null) {
  const owner = session ? downloadOwner(session) : '';
  useEffect(() => {
    if (!owner) return;
    const client = loungeDownloadClient(controller.attachments);
    const update = () => downloadManager.registerLounge({ owner, deviceId: LOUNGE_DOWNLOAD_DEVICE, client,
      ready: controller.snapshot().status === 'connected' && !!controller.snapshot().attachmentsAvailable });
    controller.attachments.enqueue = file => downloadManager.enqueue({ owner, deviceId: LOUNGE_DOWNLOAD_DEVICE,
      deviceName: t('client.lounge.title'), scope: 'computer', path: file.name, attachment: file });
    update();
    const unsubscribe = controller.subscribe(update);
    return () => {
      unsubscribe(); controller.attachments.enqueue = undefined; downloadManager.unbindLounge(owner);
    };
  }, [controller, owner]);
}
