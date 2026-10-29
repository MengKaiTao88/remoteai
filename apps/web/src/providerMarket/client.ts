import { authorizedFetch, defaultApiBaseUrl, getActiveSession } from '../api';
import type { UserProfile } from '../types';
import { copyText } from '../../../../shared/clipboard';
import type { MarketClient, MarketIdentity, MarketReply } from '../../../../shared/provider-market/types';
import { marketHttpRequest, marketResponse } from '../../../../shared/provider-market/transport';
import { downloadPublicProvider, personalProviderFields } from '../../../../shared/provider-market/install';

async function identity(): Promise<MarketIdentity | null> {
  const session = getActiveSession();
  if (!session) return null;
  const response = await authorizedFetch('/auth/me', {}, (current) => {
    if (current.baseUrl !== session.baseUrl || current.email !== session.email) throw new Error('market.signIn');
  });
  const user = await marketResponse(response) as UserProfile;
  if (getActiveSession()?.email !== session.email || getActiveSession()?.baseUrl !== session.baseUrl) {
    throw new Error('market.signIn');
  }
  return { userId: user.id, baseUrl: session.baseUrl };
}
async function authenticated(path: string, init: RequestInit, expected: MarketIdentity | null) {
  if (!expected) throw new Error('market.signIn');
  const session = getActiveSession();
  const current = await identity();
  if (!session || current?.userId !== expected.userId || current?.baseUrl !== expected.baseUrl) {
    throw new Error('market.signIn');
  }
  return marketResponse(await authorizedFetch(path, init, (next) => {
    if (next.baseUrl !== session.baseUrl || next.email !== session.email) throw new Error('market.signIn');
  }));
}
export const webProviderMarket: MarketClient = {
  identity,
  request: async (request, expected) => {
    const http = marketHttpRequest(request);
    const base = getActiveSession()?.baseUrl ?? defaultApiBaseUrl();
    const result = http.public
      ? await marketResponse(await fetch(`${base}${http.path}`, { cache: 'no-store' }))
      : await authenticated(http.path, http.init ?? {}, expected);
    return result as MarketReply;
  },
  addition: (current) => current ? 'cloud' : 'download',
  add: async (item, key, expected) => {
    if (!expected) { downloadPublicProvider(item); return 'downloaded'; }
    const fields = personalProviderFields(item, key);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const { imageInputModelsConfigured: _configured, ...syncFields } = fields;
    await authenticated(`/sync/providers/${id}`, { method: 'PUT', body: JSON.stringify({
      ...syncFields, id, lastModifiedAt: now,
      fieldModifiedAt: Object.fromEntries(Object.keys(syncFields).map((name) => [name, now])),
    }) }, expected);
    try { if (item.id) await authenticated(`/provider-market/${encodeURIComponent(item.id)}/usage`, {
      method: 'POST', body: JSON.stringify({ providerId: id }),
    }, expected); } catch { /* Statistics cannot turn a successful add into a duplicate on retry. */ }
    window.dispatchEvent(new Event('provider-market-added'));
    return 'added';
  },
  share: async (item) => {
    const url = new URL(window.location.href);
    url.searchParams.set('providerMarket', item.id);
    await copyText(url.toString());
  },
};
