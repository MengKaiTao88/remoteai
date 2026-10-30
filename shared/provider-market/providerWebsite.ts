import { pageUrl, type ProviderMarketSource } from './pageLink';

// Sites whose API host or default favicon path does not serve their website icon.
const WEBSITE_ICONS: Readonly<Record<string, string>> = {
  'api.deepseek.com': 'https://www.deepseek.com/favicon.ico',
  'ark.cn-beijing.volces.com': 'https://portal.volccdn.com/obj/volcfe/misc/favicon.png',
  'token.sensenova.cn': 'https://www.sensenova.cn/favicon.ico',
  'api.morecupai.com': 'https://morecupai.com/morecup.svg',
  'morecupai.com': 'https://morecupai.com/morecup.svg',
  'www.volcengine.com': 'https://portal.volccdn.com/obj/volcfe/misc/favicon.png',
};

/** Only the origin is shared with remote pickers; page queries and headers stay on the host. */
export function providerWebsiteOrigin(provider: { baseUrl: string; marketSource?: ProviderMarketSource | null }) {
  return pageUrl(provider.marketSource?.page.url ?? '')?.origin ?? pageUrl(provider.baseUrl)?.origin;
}

export function providerIconSources(value?: string): string[] {
  const url = pageUrl(value ?? '');
  if (!url) return [];
  const websiteIcon = Object.hasOwn(WEBSITE_ICONS, url.host) ? WEBSITE_ICONS[url.host] : undefined;
  return [...new Set([
    ...(websiteIcon ? [websiteIcon] : []),
    new URL('/favicon.ico', url.origin).href,
    new URL('/favicon.png', url.origin).href,
  ])];
}
