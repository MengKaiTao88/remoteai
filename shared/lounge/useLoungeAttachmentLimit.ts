import { useSyncExternalStore } from 'react';
import { subscribeChatPolicy } from '../remote-chat/policy';
import { attachmentByteLimit, type LoungeAttachment } from './attachments';

export function useLoungeAttachmentLimit(kind: LoungeAttachment['kind'], direct: boolean) {
  return useSyncExternalStore(subscribeChatPolicy, () => attachmentByteLimit(kind, direct));
}
