import { useState } from 'react';
import { Button, Modal } from 'antd';
import { Store } from 'lucide-react';
import type { Language } from '@remoteai/i18n';
import { marketText } from './i18n';
import type { MarketClient } from './types';
import { MarketView } from './MarketView';

export function MarketLauncher({ client, language, initialId }: {
  client: MarketClient; language: Language; initialId?: string;
}) {
  const [open, setOpen] = useState(!!initialId);
  const t = marketText(language);
  return <>
    <Button className="provider-market-button" icon={<Store size={15} />} onClick={() => setOpen(true)}>
      <span>{t('market.title')}</span></Button>
    <Modal open={open} title={t('market.title')} footer={null} width={1040} destroyOnClose
      className="provider-market-modal" onCancel={() => setOpen(false)}
      closable={{ 'aria-label': t('market.close') }}>
      <MarketView client={client} language={language} initialId={initialId} />
    </Modal>
  </>;
}
