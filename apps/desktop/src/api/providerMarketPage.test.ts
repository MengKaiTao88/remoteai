import { describe, expect, it } from 'vitest';
import { copyPageLink, hasMarketPage, resolvedPageUrl, validPageLink } from '../../../../shared/provider-market/pageLink';
import { createBrowserTab, moveTab, navigateTab } from '../../../../shared/provider-market/browserState';
import { personalProviderFields } from '../../../../shared/provider-market/install';
import { emptyTier, type MarketItem } from '../../../../shared/provider-market/types';

const marketFixture = (): MarketItem => ({
  id: '11111111-1111-4111-8111-111111111111', ownerId: 'alice', official: false, published: true,
  revision: 1, userCount: 0, sortOrder: null, name: 'Example', description: '',
  baseUrl: 'https://example.test/v1', currency: 'USD', unit: 'millionTokens',
  models: [{ id: 'model', protocol: 'openaiResponses', tiers: [emptyTier()] }],
});

const page = { url: 'https://example.test/dashboard?existing=1#balance', query: '?tag=a&tag=b&label=a%26b',
  headers: { 'X-Region': 'east' } };

describe('market page configuration', () => {
  it('appends ordered query values without destroying existing queries, escapes or fragments', () => {
    const url = new URL(resolvedPageUrl(page));
    expect(url.searchParams.get('existing')).toBe('1');
    expect(url.searchParams.getAll('tag')).toEqual(['a', 'b']);
    expect(url.searchParams.get('label')).toBe('a&b');
    expect(url.hash).toBe('#balance');
  });
  it('rejects unsafe URLs, malformed headers and unbounded configuration', () => {
    for (const url of ['file:///secret', 'javascript:alert(1)', 'https://user:password@example.test']) {
      expect(validPageLink({ ...page, url })).toBe(false);
    }
    for (const headers of [null, [], { Host: 'other.test' }, { 'X-Region': 'east\r\nInjected: yes' },
      { 'X-Region': 'east', 'x-region': 'west' }, { 'X-Region': 1 }, { 'X-Long': 'a'.repeat(4097) }]) {
      expect(validPageLink({ ...page, headers })).toBe(false);
    }
    expect(validPageLink({ ...page, query: 'x=1#fragment' })).toBe(false);
  });
  it('keeps installed provenance and page settings separate from API configuration', () => {
    const item = { ...marketFixture(), pageLink: copyPageLink(page) };
    const installed = personalProviderFields(item, 'private-key');
    expect(installed.marketSource).toEqual({ id: item.id, page });
    expect(hasMarketPage(installed)).toBe(true);
    expect(installed.baseUrl).toBe(item.baseUrl);
    expect(installed).not.toHaveProperty('requestOptions');
    item.pageLink.headers['X-Region'] = 'changed';
    expect(installed.marketSource?.page.headers['X-Region']).toBe('east');
    expect(hasMarketPage({ marketSource: null })).toBe(false);
    expect(hasMarketPage(personalProviderFields({ ...item, id: '' }, 'key'))).toBe(false);
  });
  it('keeps independent tab histories and removes forward history after new navigation', () => {
    const first = createBrowserTab({ name: 'Example', marketSource: { id: marketFixture().id, page } });
    const next = navigateTab(first, 'https://example.test/second');
    const third = navigateTab(moveTab(next, -1), 'https://example.test/third');
    expect(third.history).toEqual([first.url, 'https://example.test/third']);
    expect(first.history).toEqual([first.url]);
    expect(createBrowserTab().headers).toEqual({});
    expect(navigateTab(first, 'javascript:alert(1)')).toBe(first);
  });
});
