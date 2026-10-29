import { useRef } from 'react';
import { Button } from 'antd';
import type { MarketText } from './i18n';
import { publicDraft, type MarketDraft, type MarketItem } from './types';
import { validDraft } from './validation';

export function PublicProviderImport({ t, select, fail, disabled }: {
  t: MarketText; select: (item: MarketItem) => void; fail: () => void; disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const read = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error('market.invalid');
      const value = JSON.parse(await file.text()) as { schema?: string; provider?: MarketDraft };
      if (value.schema !== 'remoteai.provider-market.v1' || !value.provider || !validDraft(value.provider)) {
        throw new Error('market.invalid');
      }
      // Ignore every non-public field, including forged author/official/source IDs and credentials.
      select({ ...publicDraft(value.provider), id: '', ownerId: null, official: false,
        published: true, revision: 1, sortOrder: null, userCount: 0 });
    } catch { fail(); }
    finally { if (input.current) input.current.value = ''; }
  };
  return <><Button disabled={disabled} onClick={() => input.current?.click()}>{t('market.import')}</Button>
    <input ref={input} hidden type="file" accept="application/json,.json"
      aria-label={t('market.import')} onChange={(event) => void read(event.target.files?.[0])} /></>;
}
