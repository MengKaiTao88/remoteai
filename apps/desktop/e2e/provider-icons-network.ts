import { expect, type CDPSession, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const cleanups = new WeakMap<Page, () => Promise<void>>();
interface PausedRequest {
  requestId: string;
  request: { url: string; headers: Record<string, string>; postData?: string };
}

function trackRequests(page: Page, cdp: CDPSession, respond: (event: PausedRequest) => Promise<void>) {
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  const handle = (event: PausedRequest) => {
    const task = respond(event);
    pending.add(task);
    void task.then(() => pending.delete(task), error => { failures.push(error); pending.delete(task); });
  };
  cdp.on('Fetch.requestPaused', handle);
  cleanups.set(page, async () => {
    cdp.off('Fetch.requestPaused', handle);
    await Promise.allSettled(pending);
    await cdp.send('Fetch.disable');
    await cdp.detach();
    expect(failures).toEqual([]);
  });
}

export async function finishIconNetwork(page: Page) {
  await cleanups.get(page)?.();
  cleanups.delete(page);
}

// Playwright's route interception aborts any URL ending in /favicon.ico, including <img> requests.
// A separate CDP session keeps those real image requests intact while serving deterministic fixtures.
export async function setupIconNetwork(page: Page) {
  await page.unrouteAll();
  const cdp = await page.context().newCDPSession(page);
  const deepseek = await readFile(new URL('./fixtures/provider-icons/deepseek.ico', import.meta.url));
  const volcengine = await readFile(new URL('./fixtures/provider-icons/volcengine.png', import.meta.url));
  const respond = (requestId: string, body: Buffer | string, contentType: string) => cdp.send('Fetch.fulfillRequest', {
    requestId, responseCode: 200, body: Buffer.from(body).toString('base64'),
    responseHeaders: [{ name: 'Content-Type', value: contentType }],
  });
  trackRequests(page, cdp, async ({ requestId, request }) => {
    const url = new URL(request.url);
    if (url.hostname === 'offline.example.test') {
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }); return;
    }
    if (url.hostname === 'www.deepseek.com' || url.hostname === 'portal.volccdn.com') {
      const headers = Object.keys(request.headers).map(name => name.toLowerCase());
      expect(headers).not.toContain('referer'); expect(headers).not.toContain('x-private');
      if (url.hostname === 'www.deepseek.com') {
        expect(request.url).toBe('https://www.deepseek.com/favicon.ico');
        await respond(requestId, deepseek, 'image/x-icon');
      } else await respond(requestId, volcengine, 'image/png');
      return;
    }
    if (url.pathname === '/auth/me') {
      await respond(requestId, JSON.stringify({ id: 'alice', role: 'user' }), 'application/json'); return;
    }
    const call = JSON.parse(request.postData ?? '{}') as { command: string; args: Record<string, unknown> };
    const result = await page.evaluate(({ command, args }) => (
      window as unknown as { marketInvoke: (command: string, args: Record<string, unknown>) => Promise<unknown> }
    ).marketInvoke(command, args), call);
    await respond(requestId, JSON.stringify({ ok: true, result }), 'application/json');
  });
  await cdp.send('Fetch.enable', { patterns: [
    'https://www.deepseek.com/*', 'https://portal.volccdn.com/*', 'https://offline.example.test/*',
    '*/__codex_switch__/api/invoke', '*/auth/me',
  ].map(urlPattern => ({ urlPattern, requestStage: 'Request' as const })) });
}
