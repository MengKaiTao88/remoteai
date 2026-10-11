import { useCallback, useEffect, useRef, useState } from 'react';
import type { PromptSuggestionSource } from './nextPromptSuggestion';

const REQUEST_DELAY_MS = 500;
const MAX_REMEMBERED_TURNS = 256;
const MAX_SUGGESTION_CHARS = 100;

function rememberAttempt(attempted: Set<string>, key: string) {
  attempted.add(key);
  if (attempted.size <= MAX_REMEMBERED_TURNS) return;
  const oldest = attempted.values().next().value;
  if (oldest) attempted.delete(oldest);
}

export function usePromptSuggestion(source: PromptSuggestionSource | undefined, blocked = false) {
  const key = source?.target ? JSON.stringify(source.target) : '';
  const enabled = Boolean(source?.enabled && !blocked);
  const request = source?.request;
  const attempted = useRef(new Set<string>());
  const generation = useRef(0);
  const [result, setResult] = useState({ key: '', text: '' });
  const dismiss = useCallback(() => {
    generation.current++;
    if (key) rememberAttempt(attempted.current, key);
    setResult({ key: '', text: '' });
  }, [key]);

  useEffect(() => {
    if (!key || !enabled || !request || attempted.current.has(key)) return;
    const target = JSON.parse(key) as NonNullable<PromptSuggestionSource['target']>;
    let cancelled = false;
    const version = ++generation.current;
    const timer = setTimeout(() => {
      if (version !== generation.current) return;
      rememberAttempt(attempted.current, key);
      void request(target)
        .then(response => {
          if (cancelled || version !== generation.current) return;
          const text = response.suggestion?.trim() ?? '';
          if (text && Array.from(text).length <= MAX_SUGGESTION_CHARS && !/[\r\n\t]/.test(text)) {
            setResult({ key, text });
          }
        }).catch(() => { /* An unavailable prediction must never interrupt ordinary chat. */ });
    }, REQUEST_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); setResult({ key: '', text: '' }); };
  }, [key, enabled, request]);

  return { text: enabled && result.key === key ? result.text : '', dismiss };
}
