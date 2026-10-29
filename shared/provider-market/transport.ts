import type { MarketRequest } from './types';

export function marketHttpRequest(request: MarketRequest): { path: string; init?: RequestInit; public: boolean } {
  const path = '/provider-market';
  if (request.type === 'list') {
    const query = new URLSearchParams({ scope: request.scope, search: request.search, page: String(request.page) });
    return { path: `${path}${request.scope === 'mine' ? '/mine' : ''}?${query}`, public: request.scope !== 'mine' };
  }
  if (request.type === 'get') return { path: `${path}/${encodeURIComponent(request.id)}`, public: true };
  if (request.type === 'save') return { path: request.id ? `${path}/${encodeURIComponent(request.id)}` : path,
    public: false, init: { method: request.id ? 'PUT' : 'POST', body: JSON.stringify({
      draft: request.draft, revision: request.revision ?? 0, published: request.published,
    }) } };
  return { path: `${path}/${encodeURIComponent(request.id)}${request.type === 'usage' ? '/usage' : ''}`,
    public: false, init: { method: request.type === 'usage' ? 'POST' : 'DELETE',
      body: JSON.stringify(request.type === 'usage' ? { providerId: request.providerId } : { revision: request.revision }) } };
}
export async function marketResponse(response: Response): Promise<unknown> {
  if (response.ok) return response.json();
  const errors: Record<number, string> = { 400: 'market.invalid', 401: 'market.signIn',
    403: 'market.forbidden', 404: 'market.missing', 409: 'market.conflict' };
  throw new Error(errors[response.status] ?? 'market.unavailable');
}
