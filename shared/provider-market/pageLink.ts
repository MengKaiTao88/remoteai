export interface MarketPageLink {
  url: string;
  query: string;
  headers: Record<string, string>;
}

/** Installed market metadata is independent of API routing and request options. */
export interface ProviderMarketSource {
  id: string;
  page: MarketPageLink;
}

const MAX_LINK_BYTES = 16 * 1024;
const MAX_HEADERS = 32;
const MAX_URL_LENGTH = 4096;
const MAX_HEADER_LENGTH = 4096;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const RESERVED_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'cookie', 'set-cookie', 'proxy-authorization', 'proxy-connection', 'keep-alive',
]);

export function pageUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password
      && !/[\\\s]/.test(value) && value.length <= MAX_URL_LENGTH ? url : null;
  } catch { return null; }
}

export function validPageLink(value: unknown): value is MarketPageLink {
  if (!value || typeof value !== 'object') return false;
  const link = value as MarketPageLink;
  if (typeof link.url !== 'string' || !pageUrl(link.url) || typeof link.query !== 'string'
    || /[\r\n#]/.test(link.query) || !link.headers || typeof link.headers !== 'object'
    || Array.isArray(link.headers) || Object.keys(link.headers).length > MAX_HEADERS
    || new TextEncoder().encode(JSON.stringify(link)).length > MAX_LINK_BYTES) return false;
  const names = new Set<string>();
  return Object.entries(link.headers).every(([name, content]) => {
    const key = name.toLowerCase();
    if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(key) || key.startsWith('sec-')
      || names.has(key)) return false;
    names.add(key);
    return typeof content === 'string' && /^[\t\x20-\x7e]*$/.test(content) && content.length <= MAX_HEADER_LENGTH;
  });
}

export function resolvedPageUrl(link: MarketPageLink): string {
  const url = pageUrl(link.url);
  if (!url || !validPageLink(link)) throw new Error('market.invalid');
  // Append without replacing existing keys; preserve ordering, repeated values and the fragment.
  const query = link.query.replace(/^[?&]+/, '');
  if (query) url.search += `${url.search ? '&' : '?'}${query}`;
  return url.toString();
}

export function copyPageLink(link: MarketPageLink): MarketPageLink {
  return { url: link.url, query: link.query, headers: { ...link.headers } };
}

export function hasMarketPage(provider: { marketSource?: ProviderMarketSource | null }): boolean {
  const source = provider.marketSource;
  return !!source && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(source.id)
    && validPageLink(source.page);
}
