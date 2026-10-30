import { useState } from 'react';
import { Input } from 'antd';
import type { MarketText } from './i18n';
import type { MarketPageLink } from './pageLink';

export function PageLinkEditor({ value, t, onChange }: {
  value?: MarketPageLink | null; t: MarketText; onChange: (value: MarketPageLink) => void;
}) {
  const [headers, setHeaders] = useState(() => JSON.stringify(value?.headers ?? {}, null, 2));
  const page = value ?? { url: '', query: '', headers: {} };
  const updateHeaders = (text: string) => {
    setHeaders(text);
    let parsed: Record<string, string>;
    try { parsed = JSON.parse(text.trim() || '{}') as Record<string, string>; }
    catch { parsed = { '': '' }; }
    onChange({ ...page, headers: parsed });
  };
  return <section className="pm-page-link">
    <h3>{t('market.pageSettings')}</h3>
    <label><span>{t('market.pageUrl')}</span><Input value={page.url}
      aria-label={t('market.pageUrl')} aria-required="true" placeholder="https://example.com/dashboard"
      onChange={(event) => onChange({ ...page, url: event.target.value.trim() })} /></label>
    <label><span>{t('market.pageQuery')}</span><Input value={page.query}
      aria-label={t('market.pageQuery')} placeholder="source=remoteai&theme=light"
      onChange={(event) => onChange({ ...page, query: event.target.value })} /></label>
    <label><span>{t('market.pageHeaders')}</span><Input.TextArea value={headers} rows={3}
      aria-label={t('market.pageHeaders')} spellCheck={false} placeholder={'{"X-Source": "RemoteAI"}'}
      onChange={(event) => updateHeaders(event.target.value)} /></label>
    <small>{t('market.pageHint')}</small>
  </section>;
}
