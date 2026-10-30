// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMarketFeed } from '../../../../shared/provider-market/useMarketFeed';
import type { MarketClient, MarketIdentity, MarketPage } from '../../../../shared/provider-market/types';
import { fixtureItem } from '../../e2e/provider-market-support';

const item = (id: string) => ({ ...fixtureItem(), id, name: id });
const pageOf = (ids: string[], total = 120): MarketPage => ({ items: ids.map(item), total });
const onIdentity = vi.fn();
let feed: ReturnType<typeof useMarketFeed>;
let client: MarketClient;
let container: HTMLDivElement;
let root: Root;
let identity: MarketIdentity | null;

function Fixture() {
  feed = useMarketFeed(client, onIdentity);
  return <output>{feed.result.items.map((entry) => entry.id).join(',')}</output>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const render = () => act(async () => root.render(<Fixture />));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  identity = { userId: 'alice', baseUrl: 'https://cloud.test' };
  client = { identity: vi.fn(async () => identity), request: vi.fn(async () => pageOf(['first'])) };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onIdentity.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('appends pages once, preserves visible rows while loading, and stops at the total', async () => {
  await render();
  const pending = deferred<MarketPage>();
  vi.mocked(client.request).mockReturnValueOnce(pending.promise);
  await act(async () => { feed.loadMore(); feed.loadMore(); });
  expect(feed.loadingMore).toBe(true);
  expect(feed.result.items.map((entry) => entry.id)).toEqual(['first']);
  expect(client.request).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve(pageOf(['second'], 80)));
  expect(feed.result.items.map((entry) => entry.id)).toEqual(['first', 'second']);
  expect(feed.hasMore).toBe(false);
  await act(async () => feed.loadMore());
  expect(client.request).toHaveBeenCalledTimes(2);
});

it('deduplicates reordered entries and updates their metadata without changing visible order', async () => {
  await render();
  vi.mocked(client.request).mockResolvedValueOnce({ items: [item('second'), { ...item('first'), userCount: 42 }],
    total: 80 });
  await act(async () => feed.loadMore());
  expect(feed.result.items.map((entry) => entry.id)).toEqual(['first', 'second']);
  expect(feed.result.items[0].userCount).toBe(42);
});

it('keeps loaded rows after a failure and retries the failed page without skipping it', async () => {
  await render();
  vi.mocked(client.request).mockRejectedValueOnce(new Error('network'));
  await act(async () => feed.loadMore());
  expect(feed.result.items.map((entry) => entry.id)).toEqual(['first']);
  expect(feed.loadMoreError).toBe('market.unavailable');
  expect(feed.error).toBeNull();
  vi.mocked(client.request).mockResolvedValueOnce(pageOf(['second'], 80));
  await act(async () => feed.loadMore());
  expect(vi.mocked(client.request).mock.calls.slice(1).map(([request]) => 'page' in request && request.page))
    .toEqual([2, 2]);
  expect(feed.loadMoreError).toBeNull();
});

it('starts a new search at page one and ignores a late response from the previous search', async () => {
  await render();
  const stale = deferred<MarketPage>();
  vi.mocked(client.request).mockReturnValueOnce(stale.promise);
  await act(async () => feed.loadMore());
  vi.mocked(client.request).mockResolvedValueOnce(pageOf(['match'], 1));
  await act(async () => feed.find('matching'));
  await act(async () => stale.resolve(pageOf(['stale'], 120)));
  expect(client.request).toHaveBeenLastCalledWith({ type: 'list', scope: 'all', search: 'matching', page: 1 }, identity);
  expect(feed.result.items.map((entry) => entry.id)).toEqual(['match']);
  expect(feed.hasMore).toBe(false);
});

it('clears appended rows for scope changes, repeated searches, and refreshes', async () => {
  await render();
  vi.mocked(client.request).mockResolvedValueOnce(pageOf(['second']));
  await act(async () => feed.loadMore());
  vi.mocked(client.request).mockResolvedValueOnce(pageOf(['mine']));
  await act(async () => feed.selectScope('mine'));
  expect(feed.result.items.map((entry) => entry.id)).toEqual(['mine']);
  vi.mocked(client.request).mockResolvedValueOnce(pageOf(['fresh']));
  await act(async () => feed.find(''));
  expect(feed.result.items.map((entry) => entry.id)).toEqual(['fresh']);
  await act(async () => feed.reload());
  expect(client.request).toHaveBeenLastCalledWith({ type: 'list', scope: 'mine', search: '', page: 1 }, identity);
});

it('restarts from page one when the signed-in account changes instead of mixing owners', async () => {
  await render();
  identity = { userId: 'bob', baseUrl: 'https://cloud.test' };
  vi.mocked(client.request).mockResolvedValueOnce(pageOf(['bob-only'], 1));
  await act(async () => feed.loadMore());
  expect(client.request).toHaveBeenCalledTimes(2);
  expect(client.request).toHaveBeenLastCalledWith({ type: 'list', scope: 'all', search: '', page: 1 }, identity);
  expect(feed.result.items.map((entry) => entry.id)).toEqual(['bob-only']);
  expect(onIdentity).toHaveBeenLastCalledWith(identity);
});

it('handles empty pages, invalid totals, and signed-out private lists without automatic request loops', async () => {
  await render();
  vi.mocked(client.request).mockResolvedValueOnce(pageOf([], 120));
  await act(async () => feed.loadMore());
  expect(feed.hasMore).toBe(false);
  vi.mocked(client.request).mockResolvedValueOnce(pageOf(['invalid'], -1));
  await act(async () => feed.reload());
  expect(feed.error).toBe('market.unavailable');
  identity = null;
  const requestCount = vi.mocked(client.request).mock.calls.length;
  await act(async () => feed.selectScope('mine'));
  expect(client.request).toHaveBeenCalledTimes(requestCount);
  expect(feed.error).toBe('market.signIn');
});

it('ignores a stale failed page after a scope change and after unmount', async () => {
  await render();
  const stale = deferred<MarketPage>();
  vi.mocked(client.request).mockReturnValueOnce(stale.promise);
  await act(async () => feed.loadMore());
  await act(async () => feed.selectScope('official'));
  await act(async () => stale.reject(new Error('stale')));
  expect(feed.loadMoreError).toBeNull();
  const pending = deferred<MarketPage>();
  vi.mocked(client.request).mockReturnValueOnce(pending.promise);
  await act(async () => feed.loadMore());
  await act(async () => root.render(null));
  await act(async () => pending.resolve(pageOf(['discarded'])));
  expect(container.textContent).toBe('');
});

it('loads correctly through Strict Mode effect setup and cleanup', async () => {
  await act(async () => root.render(<StrictMode><Fixture /></StrictMode>));
  expect(feed.result.items.map((entry) => entry.id)).toEqual(['first']);
  expect(client.request).toHaveBeenCalledOnce();
});
