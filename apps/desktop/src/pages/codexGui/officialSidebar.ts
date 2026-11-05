import type { Thread } from '../../../../../shared/conversation/types';
import type { Grouping } from '../../../../../shared/chat/groups/model';
import { uiText } from '../../../../../shared/localization/uiText';

interface NativeSidebar { projectId: string | null; projectName: string; pinned: boolean; order: number }

function nativeSidebar(thread: Thread): NativeSidebar | undefined {
  const value: unknown = Reflect.get(thread, 'officialSidebar');
  if (!value || typeof value !== 'object' || !('projectId' in value)) return;
  return { projectId: typeof value.projectId === 'string' ? value.projectId : null,
    projectName: 'projectName' in value && typeof value.projectName === 'string' ? value.projectName : '',
    pinned: 'pinned' in value && value.pinned === true,
    order: 'projectOrder' in value && typeof value.projectOrder === 'number' ? value.projectOrder : 1_000_000 };
}

/** Official project membership is separate from a conversation's execution directory. */
export function officialSections(threads: Thread[]) {
  if (!threads.some(thread => nativeSidebar(thread))) return undefined;
  const groups = new Map<string, { id: string; label: string; cwd: string; pinned: boolean; order: number; threads: Thread[] }>();
  for (const thread of threads) {
    const native = nativeSidebar(thread);
    const id = native?.projectId ? `official-project-${native.projectId}` : 'official-recent';
    const group = groups.get(id) ?? { id, label: native?.projectId ? native.projectName : uiText('client.chat.recent'),
      cwd: '', pinned: false, order: native?.order ?? 1_000_000, threads: [] };
    group.threads.push(thread);
    groups.set(id, group);
  }
  return [...groups.values()].sort((left, right) => Number(left.id === 'official-recent')
    - Number(right.id === 'official-recent') || left.order - right.order).map(group => ({ ...group,
    threads: [...group.threads].sort((left, right) => Number(Boolean(nativeSidebar(right)?.pinned))
      - Number(Boolean(nativeSidebar(left)?.pinned))) }));
}

/** Reuse the existing remote sidebar contract so installed phone Web UIs need no deployment. */
export function officialGrouping(threads: Thread[]): Grouping | undefined {
  const sections = officialSections(threads);
  if (!sections) return undefined;
  return { projects: {}, groups: sections.map(section => ({ id: section.id, name: section.label, parentId: null })),
    threads: Object.fromEntries(sections.flatMap(section => section.threads.map(thread => [thread.id, section.id]))) };
}
