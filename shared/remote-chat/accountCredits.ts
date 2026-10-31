export interface AccountCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

/** Match the PC account column without treating an unavailable balance as zero. */
export function formatAccountCredits(credits: AccountCredits | null | undefined, locale: string, unlimited: string) {
  if (!credits) return '—';
  if (credits.unlimited) return unlimited;
  const balance = credits.balance?.trim();
  const amount = balance ? Number(balance) : NaN;
  if (Number.isFinite(amount) && amount >= 0) {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(amount);
  }
  return credits.hasCredits ? '—' : '0';
}

export function decodeAccountCredits(value: unknown): AccountCredits | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const credits = value as Partial<AccountCredits>;
  if (typeof credits.hasCredits !== 'boolean' || typeof credits.unlimited !== 'boolean'
    || (credits.balance !== null && typeof credits.balance !== 'string')) return undefined;
  return { hasCredits: credits.hasCredits, unlimited: credits.unlimited, balance: credits.balance };
}
