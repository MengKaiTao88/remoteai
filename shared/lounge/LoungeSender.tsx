import { displayText as t } from '../localization/messages';
import { accountName } from './names';
import type { LoungeAccount } from './types';

export function LoungeSender({ user, manage }: { user: LoungeAccount; manage?: () => void }) {
  const name = accountName(user);
  const content = <>
    {user.moderator === true && <span className="lounge-moderator-badge">{t('client.lounge.adminBadge')}</span>}
    <span className="lounge-sender-name">{name}</span>
  </>;
  return manage ? <button type="button" className="lounge-account lounge-sender lounge-account-action"
    aria-label={t('client.lounge.manageUser', { account: name })} onClick={manage}>{content}</button>
    : <div className="lounge-account lounge-sender">{content}</div>;
}
