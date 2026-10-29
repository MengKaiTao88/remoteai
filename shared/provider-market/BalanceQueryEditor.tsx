import { Checkbox, Input, Select } from 'antd';
import type { MarketText } from './i18n';
import type { MarketBalanceQuery } from './types';

// The example contains no credentials and demonstrates the only script contract.
const EXAMPLE = 'function parseBalance(response) {\n  return { amount: response.balance, currency: "USD" };\n}';
export function BalanceQueryEditor({ value, onChange, t }: {
  value: MarketBalanceQuery | null; onChange: (value: MarketBalanceQuery | null) => void; t: MarketText;
}) {
  return <section className="pm-balance-editor">
    <Checkbox checked={!!value} onChange={(event) => onChange(event.target.checked
      ? { url: '', auth: 'bearer', script: EXAMPLE } : null)}>{t('market.balanceScript')}</Checkbox>
    {value && <>
      <p>{t('market.scriptScope')}</p>
      <label><span>{t('market.balanceUrl')}</span><Input value={value.url}
        aria-label={t('market.balanceUrl')} onChange={(event) => onChange({ ...value, url: event.target.value })} /></label>
      <label><span>{t('market.balanceAuth')}</span><Select value={value.auth} aria-label={t('market.balanceAuth')}
        options={['bearer', 'x-api-key', 'none'].map((auth) => ({ value: auth, label: auth }))}
        onChange={(auth) => onChange({ ...value, auth })} /></label>
      <label><span>{t('market.balanceScript')}</span><Input.TextArea className="pm-code" value={value.script}
        rows={8} maxLength={16 * 1024} spellCheck={false} aria-label={t('market.balanceScript')}
        onChange={(event) => onChange({ ...value, script: event.target.value })} /></label>
    </>}
  </section>;
}
