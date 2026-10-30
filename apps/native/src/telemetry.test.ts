import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  platform: { OS: 'android' },
  application: { nativeApplicationVersion: '1.5.18', getAndroidId: vi.fn(() => 'abcdef1234567890') },
  fetch: vi.fn(),
}));
vi.mock('expo-application', () => mocks.application);
vi.mock('expo-crypto', () => ({
  randomUUID: () => '10000000-0000-4000-8000-000000000001',
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  digestStringAsync: async (_algorithm: string, input: string) => createHash('sha256').update(input).digest('hex'),
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => mocks.storage.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mocks.storage.set(key, value); },
}));
vi.mock('react-native', () => ({ Platform: mocks.platform }));

import { reportMobileActivity } from './telemetry';
import { mobileDeviceId } from './telemetryIdentity';

const BASE_URL = 'https://example.test';

function events() {
  return mocks.fetch.mock.calls.map(([, request]) => JSON.parse(request.body) as {
    deviceId: string; eventType: string; platform: string;
  });
}

beforeEach(() => {
  mocks.storage.clear();
  mocks.platform.OS = 'android';
  mocks.application.getAndroidId.mockReturnValue('abcdef1234567890');
  mocks.fetch.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', mocks.fetch);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-15T15:59:59Z'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('mobile activity telemetry', () => {
  it('reports installation and one activity for simultaneous startup/foreground callbacks', async () => {
    await Promise.all([reportMobileActivity(BASE_URL), reportMobileActivity(`${BASE_URL}/`)]);
    await reportMobileActivity(BASE_URL);
    expect(events().map((event) => event.eventType)).toEqual(['installation', 'activity']);
    expect(events().every((event) => event.platform === 'android')).toBe(true);
  });

  it.each(['android', 'ios'])('reports at Beijing midnight on %s and tracks servers separately', async (platform) => {
    mocks.platform.OS = platform;
    await reportMobileActivity(BASE_URL);
    vi.setSystemTime(new Date('2026-09-15T16:00:00Z'));
    await reportMobileActivity(BASE_URL);
    await reportMobileActivity('https://second.test');
    expect(events().map((event) => event.eventType)).toEqual([
      'installation', 'activity', 'activity', 'installation', 'activity',
    ]);
  });

  it('keeps the same activity day across UTC midnight', async () => {
    vi.setSystemTime(new Date('2026-09-15T23:59:59Z'));
    await reportMobileActivity(BASE_URL);
    vi.setSystemTime(new Date('2026-09-16T00:00:00Z'));
    await reportMobileActivity(BASE_URL);
    expect(events().map((event) => event.eventType)).toEqual(['installation', 'activity']);
  });

  it('reports again at Beijing New Year', async () => {
    vi.setSystemTime(new Date('2026-12-31T15:59:59Z'));
    await reportMobileActivity(BASE_URL);
    vi.setSystemTime(new Date('2026-12-31T16:00:00Z'));
    await reportMobileActivity(BASE_URL);
    expect(events().map((event) => event.eventType)).toEqual(['installation', 'activity', 'activity']);
  });

  it('does not register browser visits as native device activity', async () => {
    mocks.platform.OS = 'web';
    await reportMobileActivity(BASE_URL);
    expect(events()).toEqual([]);
  });

  it('retries failed activity without resending a successful installation', async () => {
    mocks.fetch.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(reportMobileActivity(BASE_URL)).rejects.toThrow('HTTP 503');
    await reportMobileActivity(BASE_URL);
    expect(events().map((event) => event.eventType)).toEqual(['installation', 'activity', 'activity']);
  });

  it('reuses the Android identifier after all installation storage is removed', async () => {
    await reportMobileActivity(BASE_URL);
    const firstId = events()[0].deviceId;
    mocks.storage.clear();
    await reportMobileActivity(BASE_URL);
    expect(events()[2].deviceId).toBe(firstId);
    expect(firstId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(firstId).not.toContain('abcdef1234567890');
  });

  it('changes identity when Android user/device identity changes, even with restored storage', async () => {
    await reportMobileActivity(BASE_URL);
    mocks.application.getAndroidId.mockReturnValue('1111111111111111');
    await reportMobileActivity(BASE_URL);
    expect(events()[2].deviceId).not.toBe(events()[0].deviceId);
    expect(events()[3].eventType).toBe('activity');
  });

  it('does not mint random Android devices when the native identifier is unavailable', async () => {
    mocks.application.getAndroidId.mockReturnValue('');
    await expect(reportMobileActivity(BASE_URL)).rejects.toThrow('unavailable');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('retains the existing iOS identifier', async () => {
    mocks.platform.OS = 'ios';
    await expect(mobileDeviceId('10000000-0000-4000-8000-000000000002'))
      .resolves.toBe('10000000-0000-4000-8000-000000000002');
  });

  it('aborts a stalled request and permits subsequent retries', async () => {
    mocks.fetch.mockImplementationOnce((_url, request: RequestInit) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const result = expect(reportMobileActivity(BASE_URL)).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    await reportMobileActivity(BASE_URL);
    expect(events().at(-1)?.eventType).toBe('activity');
  });
});
