import { useState } from 'react';
import { Alert, Button, Checkbox, Input, Space, Tag } from 'antd';
import type { MarketText } from './i18n';
import type { MarketItem, MarketPrice } from './types';
import { ProviderWebsiteIcon } from './ProviderWebsiteIcon';

function Prices({ price, t }: { price: MarketPrice; t: MarketText }) {
  return <dl className="pm-prices">{(['input', 'output', 'cachedInput'] as const).map((key) =>
    <div key={key}><dt>{t(`market.${key}`)}</dt><dd>{price[key] === null
      ? <span className="pm-muted">{t('market.missingPrice')}</span> : String(price[key])}</dd></div>)}</dl>;
}
export function MarketDetail({ item, t, busy, mode = 'local', onAdd, onShare }: {
  item: MarketItem; t: MarketText; busy: boolean; mode?: 'local' | 'cloud' | 'download';
  onAdd?: (item: MarketItem, key: string) => Promise<void>; onShare?: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [scriptEnabled, setScriptEnabled] = useState(false);
  return <article className="pm-detail">
    <div className="pm-row"><h2 className="pm-detail-title">
      <span className="pm-provider-icon"><ProviderWebsiteIcon url={item.pageLink?.url || item.baseUrl} size={24} /></span>
      <span>{item.name}</span></h2>
      <Tag>{t(item.official ? 'market.official' : 'market.community')}</Tag>
      {onShare && <Button disabled={busy} onClick={onShare}>{t('market.share')}</Button>}</div>
    {item.official && <p>{t('market.officialNote')}</p>}
    <p className="pm-description">{item.description}</p>
    <strong>{t('market.destination')}</strong><code className="pm-destination">{item.baseUrl}</code>
    {item.pageLink && <section className="pm-page-link">
      <strong>{t('market.pageSettings')}</strong><code className="pm-destination">{item.pageLink.url}</code>
      {item.pageLink.query && <p>{t('market.pageQuery')}: <code>{item.pageLink.query}</code></p>}
      {Object.keys(item.pageLink.headers).length > 0 && <>
        <strong>{t('market.pageHeaders')}</strong><pre>{JSON.stringify(item.pageLink.headers, null, 2)}</pre>
      </>}
    </section>}
    <p>{t('market.unit', { currency: item.currency })}</p>
    {item.models.map((model) => <section className="pm-model" key={model.id}>
      <h3>{model.id} <small>{model.protocol}</small></h3>
      {model.tiers.map((tier) => <section className="pm-tier" key={tier.multiplier}>
        <h4>{tier.multiplier}×</h4><strong>{t('market.normal')}</strong><Prices price={tier} t={t} />
        <p>{t('market.longContextThreshold')}: {tier.longContextThreshold ?? t('market.missingPrice')}</p>
        <strong>{t('market.longContext')}</strong><Prices price={tier.longContext} t={t} />
      </section>)}
    </section>)}
    <p className="pm-muted">{t('market.pricesNote')}</p>
    {item.balanceQuery && <section className="pm-script-review">
      <h3>{t('market.balanceScript')}</h3><p>{t('market.scriptScope')}</p>
      <code className="pm-destination">{item.balanceQuery.url}</code>
      <p>{t('market.balanceAuth')}: {item.balanceQuery.auth}</p>
      <pre>{item.balanceQuery.script}</pre>
      {onAdd && mode !== 'download' && <Checkbox checked={scriptEnabled} disabled={busy}
        onChange={(event) => setScriptEnabled(event.target.checked)}>{t('market.enableScript')}</Checkbox>}
    </section>}
    {onAdd && <section className="pm-install">
      <Alert type="info" message={t(mode === 'download' ? 'market.webAnonymousInfo' : 'market.addInfo')} />
      {mode === 'cloud' && <p>{t('market.webAddInfo')}</p>}
      {mode !== 'download' && <label><span>{t('market.ownKey')}</span>
        <Input.Password value={apiKey} disabled={busy} autoComplete="new-password" aria-label={t('market.ownKey')}
          onChange={(event) => setApiKey(event.target.value)} /></label>}
      <Space><Button type="primary" loading={busy} disabled={mode !== 'download' && !apiKey.trim()}
        onClick={() => void onAdd({ ...item, balanceQuery: mode === 'download' || scriptEnabled
          ? item.balanceQuery : null }, apiKey.trim())}>
        {t(mode === 'download' ? 'market.webAnonymousAdd' : 'market.add')}</Button></Space>
    </section>}
  </article>;
}
