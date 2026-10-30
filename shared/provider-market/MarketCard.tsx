import { Button, Popconfirm, Space, Tag } from 'antd';
import type { MarketText } from './i18n';
import { publicDraft, type MarketItem, type MarketRequest } from './types';

export function MarketCard({ item, owned, busy, t, onSelect, onEdit, onWrite }: {
  item: MarketItem; owned: boolean; busy: boolean; t: MarketText;
  onSelect: (item: MarketItem) => void; onEdit: (item: MarketItem) => void;
  onWrite: (request: MarketRequest) => Promise<void>;
}) {
  return <article className="pm-card">
    <div className="pm-card-header">
      <button className="pm-card-title" onClick={() => onSelect(item)}>{item.name}</button>
      {owned && <Space wrap className="pm-card-actions">
        <Button disabled={busy} onClick={() => onEdit(item)}>{t('market.edit')}</Button>
        <Button disabled={busy} onClick={() => void onWrite({ type: 'save',
          id: item.id, revision: item.revision, draft: publicDraft(item), published: !item.published })}>
          {t(item.published ? 'market.withdraw' : 'market.republish')}</Button>
        <Popconfirm title={t('market.deleteConfirm')} overlayStyle={{ maxWidth: 400 }}
          okText={t('market.confirmDelete')} cancelText={t('market.cancel')}
          onConfirm={() => onWrite({ type: 'remove', id: item.id, revision: item.revision })}>
          <Button danger disabled={busy}>{t('market.remove')}</Button>
        </Popconfirm>
      </Space>}
    </div>
    <Space wrap><Tag>{t(item.official ? 'market.official' : 'market.community')}</Tag>
      {!item.published && <Tag>{t('market.unpublished')}</Tag>}
      <span>{t('market.users', { count: item.userCount })}</span></Space>
    <p>{item.description}</p><code>{new URL(item.baseUrl).host}</code>
    <p>{item.models.map((model) => model.id).join(' · ')}</p>
  </article>;
}
