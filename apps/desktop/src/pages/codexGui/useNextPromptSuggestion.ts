import { useCallback, useEffect, useRef, useState } from 'react';
import { guiApi } from './api';
import type { GuiState } from './types';

const REQUEST_DELAY_MS = 500;
const MAX_REMEMBERED_TURNS = 256;
const MAX_SUGGESTION_CHARS = 100;
const FAST_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

function rememberAttempt(attempted: Set<string>, key: string) {
  attempted.add(key);
  if (attempted.size <= MAX_REMEMBERED_TURNS) return;
  const oldest = attempted.values().next().value;
  if (oldest) attempted.delete(oldest);
}

function predictionTarget(state: GuiState) {
  const current = state.selected ? state.conversations[state.selected] : undefined;
  const turn = current?.turns.at(-1);
  const model = state.models.find(entry => entry.model === state.settings.model);
  if (!state.selected || !turn || turn.status !== 'completed' || !model
    || !turn.items.some(item => item.type === 'agentMessage' && item.phase !== 'commentary'
      && item.delivery !== 'async' && item.text?.trim())) return null;
  const effort = FAST_EFFORTS.find(value => model.supportedReasoningEfforts
    .some(entry => entry.reasoningEffort === value));
  if (!effort) return null;
  return { threadId: state.selected, sourceTurnId: turn.id, model: model.model, effort };
}

export function useNextPromptSuggestion(state: GuiState, options: { active: boolean; blocked: boolean }) {
  const target = predictionTarget(state);
  const key = target ? JSON.stringify(target) : '';
  const current = state.selected ? state.conversations[state.selected] : undefined;
  const enabled = options.active && !options.blocked && state.connection === 'ready'
    && !state.loading && !state.sending && !state.archived && !state.compacting && !state.workspaceBusy
    && !state.modelSettingsLoading && !state.modelCatalogLoading && !current?.activeTurn && !current?.error
    && !state.goals?.[state.selected ?? ''] && !state.queued[state.selected ?? '']?.length
    && !state.approvals.some(event => event.params.threadId === state.selected);
  const attempted = useRef(new Set<string>());
  const generation = useRef(0);
  const [result, setResult] = useState({ key: '', text: '' });
  const dismiss = useCallback(() => {
    generation.current++;
    if (key) rememberAttempt(attempted.current, key);
    setResult({ key: '', text: '' });
  }, [key]);

  useEffect(() => {
    if (!key || !enabled || attempted.current.has(key)) return;
    const request = JSON.parse(key) as NonNullable<ReturnType<typeof predictionTarget>>;
    let cancelled = false;
    const version = ++generation.current;
    const timer = setTimeout(() => {
      if (version !== generation.current) return;
      rememberAttempt(attempted.current, key);
      void guiApi.request<{ suggestion: string | null }>({ operation: 'suggestNextPrompt', ...request })
        .then(response => {
          if (cancelled || version !== generation.current) return;
          const text = response.suggestion?.trim() ?? '';
          if (text && Array.from(text).length <= MAX_SUGGESTION_CHARS && !/[\r\n\t]/.test(text)) {
            setResult({ key, text });
          }
        }).catch(() => { /* An unavailable prediction must never interrupt ordinary chat. */ });
    }, REQUEST_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); setResult({ key: '', text: '' }); };
  }, [key, enabled]);

  return { text: enabled && result.key === key ? result.text : '', dismiss };
}
