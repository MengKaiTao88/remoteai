import { guiApi } from './api';
import type { GuiState } from './types';
import { promptSuggestionTarget, type RequestPromptSuggestion } from '../../../../../shared/chat/nextPromptSuggestion';
import { usePromptSuggestion } from '../../../../../shared/chat/usePromptSuggestion';

const request: RequestPromptSuggestion = target => guiApi.request({ operation: 'suggestNextPrompt', ...target });

export function useNextPromptSuggestion(state: GuiState, options: { active: boolean; blocked: boolean }) {
  const current = state.selected ? state.conversations[state.selected] : undefined;
  const target = promptSuggestionTarget(current ? { id: current.thread.id, turns: current.turns } : null,
    state.models.find(model => model.model === state.settings.model));
  const enabled = options.active && state.connection === 'ready'
    && !state.loading && !state.sending && !state.archived && !state.compacting && !state.workspaceBusy
    && !state.modelSettingsLoading && !state.modelCatalogLoading && !current?.activeTurn && !current?.error
    && !state.goals?.[state.selected ?? ''] && !state.queued[state.selected ?? '']?.length
    && !state.approvals.some(event => event.params.threadId === state.selected);
  return usePromptSuggestion({ target, enabled, request }, options.blocked);
}
