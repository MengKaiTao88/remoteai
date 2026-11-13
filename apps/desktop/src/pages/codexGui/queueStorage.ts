import { invoke } from '../../api/backend';
import type { QueueSnapshot, QueueStorage } from './queueJournal';
import { backendSnapshot } from './backendScope';

export const queueStorage: QueueStorage = {
  get reviewRestoredFailures() { return backendSnapshot().backend === 'official'; },
  read: () => invoke<QueueSnapshot>('codex_gui_queue_read'),
  save: snapshot => invoke<QueueSnapshot>('codex_gui_queue_save', { snapshot }),
};
