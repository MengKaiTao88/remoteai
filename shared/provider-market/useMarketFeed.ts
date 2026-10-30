import { useCallback, useEffect, useRef, useState } from 'react';
import { marketError, type MarketKey } from './i18n';
import type { MarketClient, MarketIdentity, MarketItem, MarketPage, MarketReply, MarketRequest } from './types';
import { parseItem } from './validation';

const PAGE_SIZE = 40;
const MAX_PAGE = 10_000;
type Scope = Extract<MarketRequest, { type: 'list' }>['scope'];
interface Session {
  active: boolean; pending: boolean; page: number; hasMore: boolean; identity: MarketIdentity | null;
}
const emptyPage = (): MarketPage => ({ items: [], total: 0 });
export const sameIdentity = (left: MarketIdentity | null, right: MarketIdentity | null) =>
  left?.userId === right?.userId && left?.baseUrl === right?.baseUrl;

function parsePage(response: MarketReply): MarketPage {
  if (!('items' in response) || !Array.isArray(response.items)
    || !Number.isSafeInteger(response.total) || response.total < 0) throw new Error('market.unavailable');
  return { items: response.items.map(parseItem), total: response.total };
}

function appendItems(previous: MarketItem[], incoming: MarketItem[]): MarketItem[] {
  const items = new Map(previous.map((item) => [item.id, item]));
  incoming.forEach((item) => items.set(item.id, item));
  return [...items.values()];
}

export function useMarketFeed(client: MarketClient, onIdentity: (identity: MarketIdentity | null) => void) {
  const [scope, setScope] = useState<Scope>('all');
  const [search, setSearch] = useState('');
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<MarketPage>(emptyPage);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<MarketKey | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<MarketKey | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  const readPage = useCallback(async (session: Session, page: number) => {
    if (!session.active || session.pending) return;
    session.pending = true;
    if (page > 1) { setLoadingMore(true); setLoadMoreError(null); }
    try {
      const identity = await client.identity();
      if (!session.active) return;
      onIdentity(identity);
      if (page > 1 && !sameIdentity(session.identity, identity)) { reload(); return; }
      if (scope === 'mine' && !identity) throw new Error('market.signIn');
      const response = await client.request({ type: 'list', scope, search, page }, identity);
      if (!session.active) return;
      const next = parsePage(response);
      session.identity = identity;
      session.page = page;
      session.hasMore = next.items.length > 0 && page * PAGE_SIZE < next.total && page < MAX_PAGE;
      setResult((previous) => ({ items: page === 1 ? next.items : appendItems(previous.items, next.items),
        total: next.total }));
      setHasMore(session.hasMore);
    } catch (reason) {
      if (session.active) (page === 1 ? setError : setLoadMoreError)(marketError(reason));
    } finally {
      session.pending = false;
      if (session.active) { setLoading(false); setLoadingMore(false); }
    }
  }, [client, scope, search, onIdentity, reload]);

  useEffect(() => {
    const session: Session = { active: true, pending: false, page: 0, hasMore: false, identity: null };
    sessionRef.current = session;
    setResult(emptyPage()); setHasMore(false); setLoading(true); setLoadingMore(false);
    setError(null); setLoadMoreError(null);
    void readPage(session, 1);
    return () => { session.active = false; };
  }, [readPage, revision]);

  const loadMore = useCallback(() => {
    const session = sessionRef.current;
    if (session?.hasMore) void readPage(session, session.page + 1);
  }, [readPage]);

  return { result, scope, search, loading, loadingMore, hasMore, error, loadMoreError,
    loadMore, reload, selectScope: setScope, find: (value: string) => { setSearch(value); reload(); } };
}
