import { displayExpirationDate } from '../../../../shared/accounts/expiration';

export function accountExpirationDate(
  manualExpiration?: string | null,
  subscriptionActiveUntil?: string | null,
) {
  const value = manualExpiration?.trim() || subscriptionActiveUntil?.trim();
  return value ? displayExpirationDate(value) : null;
}
