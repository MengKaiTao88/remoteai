import { Button, Input, InputNumber, Select } from 'antd';
import type { MarketText } from './i18n';
import { emptyTier, MARKET_PROTOCOLS, type MarketModel } from './types';
import { PriceFields } from './PriceFields';

export function ModelEditor({ value, onChange, onRemove, t }: {
  value: MarketModel; onChange: (model: MarketModel) => void; onRemove?: () => void; t: MarketText;
}) {
  const setTier = (index: number, tier: MarketModel['tiers'][number]) =>
    onChange({ ...value, tiers: value.tiers.map((item, position) => position === index ? tier : item) });
  const addTier = () => {
    let multiplier = 1;
    while (value.tiers.some((tier) => tier.multiplier === multiplier)) multiplier++;
    onChange({ ...value, tiers: [...value.tiers, emptyTier(multiplier)] });
  };
  return <section className="pm-model-editor">
    <div className="pm-row">
      <label><span>{t('market.model')}</span><Input value={value.id} maxLength={128}
        aria-label={t('market.model')} onChange={(event) => onChange({ ...value, id: event.target.value })} /></label>
      <label><span>{t('market.protocol')}</span><Select value={value.protocol} aria-label={t('market.protocol')}
        options={MARKET_PROTOCOLS.map((protocol) => ({ value: protocol, label: protocol }))}
        onChange={(protocol) => onChange({ ...value, protocol })} /></label>
      <Button danger disabled={!onRemove} onClick={onRemove}>{t('market.removeModel')}</Button>
    </div>
    {value.tiers.map((tier, index) => <div className="pm-tier-editor" key={index}>
      <div className="pm-row">
        <label><span>{t('market.multiplier')}</span><InputNumber value={tier.multiplier} min={0.001} max={1000}
          aria-label={t('market.multiplier')} onChange={(number) => setTier(index, { ...tier, multiplier: number ?? 0 })} />
        </label>
        <Button danger disabled={value.tiers.length === 1} onClick={() => onChange({
          ...value, tiers: value.tiers.filter((_, position) => position !== index),
        })}>{t('market.removeTier')}</Button>
      </div>
      <strong>{t('market.normal')}</strong><PriceFields value={tier} t={t}
        onChange={(price) => setTier(index, { ...tier, ...price })} />
      <label><span>{t('market.longContextThreshold')}</span><InputNumber value={tier.longContextThreshold}
        min={1} max={1_000_000_000} precision={0} aria-label={t('market.longContextThreshold')}
        placeholder={t('market.missingPrice')}
        onChange={(number) => setTier(index, { ...tier, longContextThreshold: number })} /></label>
      <strong>{t('market.longContext')}</strong><PriceFields value={tier.longContext} t={t}
        onChange={(price) => setTier(index, { ...tier, longContext: price })} />
    </div>)}
    <Button disabled={value.tiers.length >= 16} onClick={addTier}>{t('market.addTier')}</Button>
  </section>;
}
