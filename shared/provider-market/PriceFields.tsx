import { InputNumber } from 'antd';
import type { MarketText } from './i18n';
import type { MarketPrice } from './types';

export function PriceFields({ value, onChange, t }: {
  value: MarketPrice; onChange: (value: MarketPrice) => void; t: MarketText;
}) {
  return <div className="pm-price-fields">{(['input', 'output', 'cachedInput'] as const).map((key) =>
    <label key={key}><span>{t(`market.${key}`)}</span>
      <InputNumber aria-label={t(`market.${key}`)} min={0} max={1e12} value={value[key]}
        placeholder={t('market.missingPrice')} onChange={(number) => onChange({ ...value, [key]: number })} />
    </label>)}</div>;
}
