import { useCallback, useEffect, useRef, useState } from 'react';
import { marketError, type MarketKey } from './i18n';
import { publicDraft, type MarketClient, type MarketDraft, type MarketIdentity, type MarketItem,
  type MarketPage, type MarketRequest } from './types';
import { parseItem } from './validation';

export const sameIdentity = (left: MarketIdentity | null, right: MarketIdentity | null) =>
  left?.userId === right?.userId && left?.baseUrl === right?.baseUrl;

export function useMarket(client: MarketClient, initialId?: string) {
  const [identity, setIdentity] = useState<MarketIdentity | null>(null);
  const [scope, setScope] = useState<'all' | 'official' | 'community' | 'mine'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<MarketPage>({ items: [], total: 0 });
  const [selected, setSelected] = useState<MarketItem | null>(null);
  const [editor, setEditor] = useState<MarketItem | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<MarketKey | null>(null);
  const [notice, setNotice] = useState<MarketKey | null>(null);
  const [revision, setRevision] = useState(0);
  const locked = useRef(false);
  const mounted = useRef(true);
  const observedIdentity = useRef<MarketIdentity | null | undefined>(undefined);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    void (async () => {
      const current = await client.identity();
      if (!active) return;
      if (observedIdentity.current !== undefined && !sameIdentity(observedIdentity.current, current)) {
        setEditor(null); setSelected(null);
      }
      observedIdentity.current = current;
      setIdentity(current);
      if (scope === 'mine' && !current) throw new Error('market.signIn');
      const response = await client.request({ type: 'list', scope, search, page }, current);
      if (!('items' in response) || !Array.isArray(response.items)) throw new Error('market.unavailable');
      const items = response.items.map(parseItem);
      if (active) setResult({ items, total: response.total });
    })().catch((reason) => { if (active) { setError(marketError(reason)); setResult({ items: [], total: 0 }); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, page, revision, scope, search]);
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  useEffect(() => {
    let active = true;
    if (initialId) void client.request({ type: 'get', id: initialId }, null)
      .then((value) => { if (active) setSelected(parseItem(value)); })
      .catch((reason) => { if (active) setError(marketError(reason)); });
    return () => { active = false; };
  }, [client, initialId]);
  const run = async (action: (current: MarketIdentity | null) => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const current = await client.identity();
      if (!sameIdentity(identity, current)) {
        setIdentity(current); setEditor(null); reload(); throw new Error('market.signIn');
      }
      await action(current);
    } catch (reason) { if (mounted.current) setError(marketError(reason)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const write = async (request: MarketRequest) => run(async (current) => {
    if (!current) throw new Error('market.signIn');
    await client.request(request, current);
    if (!mounted.current) return;
    if (!sameIdentity(current, await client.identity())) throw new Error('market.signIn');
    setEditor(null); setSelected(null); setNotice('market.saved'); reload();
  });
  const save = async (draft: MarketDraft, published: boolean) => write({ type: 'save', draft: publicDraft(draft),
    published, ...(editor && editor !== 'new' ? { id: editor.id, revision: editor.revision } : {}) });
  const add = async (item: MarketItem, key: string) => run(async (current) => {
    if (!client.add) return;
    const outcome = await client.add(item, key, current);
    if (mounted.current) { setSelected(null); setNotice(`market.${outcome}`); reload(); }
  });
  return { identity, scope, search, page, result, selected, editor, busy, loading, error, notice,
    reload, setPage, setSelected, setEditor, setError, save, add, write,
    retry: () => {
      if (error === 'market.conflict' || error === 'market.forbidden' || error === 'market.missing') {
        setEditor(null); setSelected(null);
      }
      reload();
    },
    selectScope: (value: typeof scope) => { setScope(value); setPage(1); },
    find: (value: string) => { setSearch(value); setPage(1); },
    share: async (item: MarketItem) => run(async () => {
      await client.share?.(item); setNotice('market.copied');
    }),
  };
}
