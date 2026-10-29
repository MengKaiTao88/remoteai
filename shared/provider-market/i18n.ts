import { createI18n, type Language } from '@remoteai/i18n';
import { resources } from '@remoteai/i18n/common';
import { createErrorFormatter } from '@remoteai/i18n/errors';

export const formatMarketError = createErrorFormatter(resources);

export type MarketKey = Extract<keyof typeof resources.en, `market.${string}`>;
export type MarketText = (key: MarketKey, values?: Record<string, string | number>) => string;
export function marketText(language: Language): MarketText {
  const engine = createI18n({ locale: language, resources });
  return (key, values) => engine.text(key, values);
}
export function marketError(error: unknown): MarketKey {
  const raw = error instanceof Error ? error.message : String(error);
  const keys: MarketKey[] = ['market.signIn', 'market.invalid', 'market.conflict',
    'market.forbidden', 'market.missing'];
  return keys.find((key) => raw === key) ?? 'market.unavailable';
}
