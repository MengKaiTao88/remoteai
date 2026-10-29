import { useMemo } from 'react';
import { Alert, Button, Empty, Input, Popconfirm, Segmented, Space, Spin, Tag } from 'antd';
import type { Language } from '@remoteai/i18n';
import { marketText } from './i18n';
import type { MarketClient, MarketItem } from './types';
import { publicDraft } from './types';
import { useMarket } from './useMarket';
import { MarketDetail } from './MarketDetail';
import { MarketEditor } from './MarketEditor';
import { PublicProviderImport } from './PublicProviderImport';
import './market.css';

export function MarketView({ client, language, initialId }: {
  client: MarketClient; language: Language; initialId?: string;
}) {
  const t = useMemo(() => marketText(language), [language]);
  const market = useMarket(client, initialId);
  const owned = (item: MarketItem) => !item.official && !!market.identity && item.ownerId === market.identity.userId;
  return <div className="provider-market">
    <p>{t('market.intro')}</p>
    {market.error && <Alert type="error" showIcon message={t(market.error)} action={
      <Button onClick={market.retry} disabled={market.busy}>{t('market.retry')}</Button>} />}
    {market.notice && <Alert type="success" showIcon message={t(market.notice)} />}
    {market.editor ? <MarketEditor key={market.editor === 'new' ? 'new' : market.editor.id}
      initial={market.editor === 'new' ? undefined : market.editor} t={t} busy={market.busy}
      onSave={market.save} onCancel={() => market.setEditor(null)} /> : market.selected ? <>
      <Button disabled={market.busy} onClick={() => market.setSelected(null)}>{t('market.back')}</Button>
      <MarketDetail key={`${market.selected.id}:${market.identity?.userId ?? ''}`}
        item={market.selected} t={t} busy={market.busy} onAdd={client.add ? market.add : undefined}
        mode={client.addition?.(market.identity)}
        onShare={client.share && market.selected.id ? () => void market.share(market.selected!) : undefined} />
    </> : <>
      <div className="pm-toolbar"><Segmented value={market.scope} disabled={market.busy}
        options={(['all', 'official', 'community', 'mine'] as const).map((value) => ({ value, label: t(`market.${value}`) }))}
        onChange={(value) => market.selectScope(value as typeof market.scope)} />
        <Space wrap><PublicProviderImport t={t} disabled={market.busy} select={market.setSelected}
          fail={() => market.setError('market.invalid')} />
          <Button type="primary" disabled={market.busy} onClick={() => market.identity
            ? market.setEditor('new') : market.setError('market.signIn')}>{t('market.publish')}</Button></Space></div>
      <Input.Search aria-label={t('market.search')} placeholder={t('market.search')}
        allowClear onSearch={market.find} maxLength={160} />
      <p className="pm-muted">{t('market.statsNotice')}</p>
      {market.loading ? <div role="status" className="pm-loading"><Spin /> {t('market.loading')}</div>
        : !market.result.items.length ? <Empty description={t('market.empty')} />
          : <div className="pm-list">{market.result.items.map((item) => <article className="pm-card" key={item.id}>
            <button className="pm-card-title" onClick={() => market.setSelected(item)}>{item.name}</button>
            <Space wrap><Tag>{t(item.official ? 'market.official' : 'market.community')}</Tag>
              {!item.published && <Tag>{t('market.unpublished')}</Tag>}
              <span>{t('market.users', { count: item.userCount })}</span></Space>
            <p>{item.description}</p><code>{new URL(item.baseUrl).host}</code>
            <p>{item.models.map((model) => model.id).join(' · ')}</p>
            {owned(item) && <Space wrap>
              <Button disabled={market.busy} onClick={() => market.setEditor(item)}>{t('market.edit')}</Button>
              <Button disabled={market.busy} onClick={() => void market.write({ type: 'save',
                id: item.id, revision: item.revision, draft: publicDraft(item), published: !item.published })}>
                {t(item.published ? 'market.withdraw' : 'market.republish')}</Button>
              <Popconfirm title={t('market.deleteConfirm')} overlayStyle={{ maxWidth: 400 }}
                okText={t('market.confirmDelete')} cancelText={t('market.cancel')}
                onConfirm={() => market.write({ type: 'remove', id: item.id, revision: item.revision })}>
                <Button danger disabled={market.busy}>{t('market.remove')}</Button>
              </Popconfirm>
            </Space>}
          </article>)}</div>}
      <Space><Button disabled={market.page === 1 || market.loading} onClick={() => market.setPage(market.page - 1)}>
        {t('market.previous')}</Button><Button disabled={market.page * 40 >= market.result.total || market.loading}
        onClick={() => market.setPage(market.page + 1)}>{t('market.next')}</Button></Space>
    </>}
  </div>;
}
