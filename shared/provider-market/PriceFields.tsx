import { InputNumber } from 'antd';
import type { MarketText } from './i18n';
import type { MarketDraft, MarketPrice } from './types';

const CURRENCY_SYMBOLS: Record<MarketDraft['currency'], string> = { USD: '$', CNY: '¥', EUR: '€', JPY: '¥' };

export function PriceFields({ value, currency, onChange, t }: {
  value: MarketPrice; currency: MarketDraft['currency']; onChange: (value: MarketPrice) => void; t: MarketText;
}) {
  return <>{(['input', 'output', 'cachedInput'] as const).map((key) =>
    <label key={key}><span>{t(`market.${key}Price`)}</span>
      <InputNumber aria-label={t(`market.${key}`)} addonBefore={CURRENCY_SYMBOLS[currency]}
        min={0} max={1e12} value={value[key]}
        placeholder={t('market.missingPrice')} onChange={(number) => onChange({ ...value, [key]: number })} />
    </label>)}</>;
}
