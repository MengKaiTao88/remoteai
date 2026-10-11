import { t, useLanguage } from '../i18n';
import type { messageReferences } from '../../../../shared/chat/messageReferences';
import './messageReferences.css';

export function ChatMessageReferences({ references }: { references: ReturnType<typeof messageReferences> }) {
  useLanguage();
  if (!references.length) return null;
  return <div className="chat-message-references">
    {references.map(reference => <span className="chat-message-reference" key={reference.path}>
      {t(reference.label)}：{reference.name}
    </span>)}
  </div>;
}
