import { t } from '../i18n';
import './composerSuggestion.css';

export function ComposerSuggestion({ text, accept }: { text: string; accept: () => void }) {
  if (!text) return null;
  return <button type="button" className="chat-prompt-suggestion" aria-label={t('填入建议')}
    onPointerDown={event => event.preventDefault()} onClick={accept}>
    <span>{text}</span><small>{t('填入')}</small>
  </button>;
}
