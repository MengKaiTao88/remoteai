import { useEffect } from 'react';
import { downloadManager } from '../../apps/web/src/downloads/manager';
import { displayText as t } from '../localization/messages';
import type { LoungeController } from './controller';
import { loungeDownloadClient, LOUNGE_DOWNLOAD_DEVICE } from './downloadClient';

export function useBrowserLoungeDownloads(controller: LoungeController, owner: string) {
  useEffect(() => {
    if (!owner) return;
    const client = loungeDownloadClient(controller.attachments);
    const update = () => downloadManager.registerLounge({ owner, deviceId: LOUNGE_DOWNLOAD_DEVICE,
      deviceName: t('client.lounge.title'), ready: controller.snapshot().status === 'connected'
        && !!controller.snapshot().attachmentsAvailable,
      mode: 'relay', client });
    controller.attachments.enqueue = file => downloadManager.enqueue({ owner, deviceId: LOUNGE_DOWNLOAD_DEVICE,
      deviceName: t('client.lounge.title'), scope: 'computer', path: file.name, attachment: file });
    void downloadManager.initialize(); update();
    const unsubscribe = controller.subscribe(update);
    return () => {
      unsubscribe(); controller.attachments.enqueue = undefined; downloadManager.unbindLounge(owner);
    };
  }, [controller, owner]);
}
