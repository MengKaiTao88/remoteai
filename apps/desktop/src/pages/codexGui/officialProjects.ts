import { invoke } from '../../api/backend';
import type { ChatProject } from '../../../../../shared/remote-chat/client/types';

export async function readOfficialProjects(cwd?: string): Promise<ChatProject[]> {
  const response = await invoke<{ data: ChatProject[] }>('codex_gui_request', {
    request: { operation: 'officialProjects', cwd },
  });
  return response.data;
}

export async function loadOfficialSavedProjects() {
  return (await readOfficialProjects()).map(({ cwd, label }) => ({ path: cwd, name: label }));
}
