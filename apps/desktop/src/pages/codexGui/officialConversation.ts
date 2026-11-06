import { guiApi } from '../../../../../shared/conversation/api';
import { backendSnapshot } from './backendScope';

/** Explicit selection may attach an unloaded owner; background history reads remain passive. */
export async function activateOfficialConversation(threadId: string) {
  if (backendSnapshot().backend !== 'official') return;
  // Official mode preserves the native owner's permissions and does not forward this GUI access field.
  await guiApi.request({ operation: 'resume', threadId, access: 'read-only', summaryOnly: true });
}
