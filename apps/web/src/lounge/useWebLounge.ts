import { browserAttachmentImages } from '../../../../shared/lounge/attachmentCache';
import { browserAttachmentSink } from '../../../../shared/lounge/browserAttachments';
import { useMemo } from 'react';
import { LoungeController } from '../../../../shared/lounge/controller';
import { browserAvatarStore } from '../../../../shared/lounge/avatar';
import { browserLoungeHistory } from '../../../../shared/lounge/browserHistory';
import { useLounge } from '../../../../shared/lounge/useLounge';
import { browserLoungeSync } from '../../../../shared/lounge/browserSync';
import { apiJson, getActiveSession } from '../api';
import type { AuthSession } from '../types';
import { useBrowserLoungeDownloads } from '../../../../shared/lounge/useBrowserLoungeDownloads';
import { downloadOwner } from '../downloads/manager';

export function useWebLounge(session: AuthSession | null) {
  const baseUrl = session?.baseUrl;
  const email = session?.email;
  const controller = useMemo(() => new LoungeController(baseUrl && email ? {
    sync: browserLoungeSync,
    attachmentImages: browserAttachmentImages(JSON.stringify([baseUrl, email]), browserAttachmentSink),
    baseUrl, account: email, avatars: browserAvatarStore(baseUrl),
    // Profile refreshes must not replace the live connection and discard recent speakers or drafts.
    get userId() {
      const current = getActiveSession();
      return current?.baseUrl === baseUrl && current.email === email ? current.profile?.id : undefined;
    },
    history: browserLoungeHistory(baseUrl, email), authorize: async () => {
      const current = getActiveSession();
      if (current?.baseUrl !== baseUrl || current.email !== email) throw new Error('client.lounge.signIn');
      return apiJson<{ ticket: string }>('/lounge/ticket', { method: 'POST' });
    },
  } : undefined), [baseUrl, email]);
  const state = useLounge(controller);
  useBrowserLoungeDownloads(controller, session ? downloadOwner(session) : '');
  return { controller, state };
}
