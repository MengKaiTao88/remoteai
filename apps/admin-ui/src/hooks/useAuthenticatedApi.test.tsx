import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useAuthenticatedApi } from './useAuthenticatedApi';
import type { AuthTokens } from '../types';
import type { Translate } from '../i18n';

const auth = (id: string): AuthTokens => ({ accessToken: `${id}-access`, refreshToken: `${id}-refresh`,
  user: { id, email: `${id}@test.invalid`, role: 'admin' } });
const t = ((key: string) => key) as Translate;
afterEach(() => vi.unstubAllGlobals());
it('does not replay a mutation or replace credentials after an account switch during refresh', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let finish: (response: Response) => void = () => {};
  const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 401 }))
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
  vi.stubGlobal('fetch', fetch);
  const save = vi.fn();
  let api: ReturnType<typeof useAuthenticatedApi>['api'];
  function Harness({ tokens }: { tokens: AuthTokens }) { api = useAuthenticatedApi(tokens, save, t).api; return null; }
  const container = document.createElement('div'); const root = createRoot(container);
  await act(async () => root.render(<Harness tokens={auth('alice')} />));
  const pending = api!('/admin/api/provider-market', { method: 'POST' }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => root.render(<Harness tokens={auth('bob')} />));
  finish(new Response(JSON.stringify(auth('alice'))));
  expect(await pending).toBeInstanceOf(Error);
  expect(save).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});
