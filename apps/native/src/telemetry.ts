import * as Application from 'expo-application';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { mobileDeviceId } from './telemetryIdentity';

const INSTALLATION_KEY = 'codex-switch.mobile.installation.v1';
const REQUEST_TIMEOUT_MS = 10_000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1_000;

interface InstallationState {
  deviceId: string;
  reportedVersions: Record<string, string>;
  reportedActivityDays: Record<string, string>;
}

let reporting: Promise<void> = Promise.resolve();

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === 'string'));
}

async function loadInstallation(): Promise<InstallationState> {
  let stored: Partial<InstallationState> = {};
  try {
    const raw = await SecureStore.getItemAsync(INSTALLATION_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') stored = parsed;
  } catch {
    // Corrupt telemetry state must not prevent reporting with the stable Android identifier.
  }
  const previousId = typeof stored.deviceId === 'string' ? stored.deviceId : undefined;
  const deviceId = await mobileDeviceId(previousId);
  const unchanged = deviceId === previousId;
  const state = {
    deviceId,
    reportedVersions: unchanged ? stringRecord(stored.reportedVersions) : {},
    reportedActivityDays: unchanged ? stringRecord(stored.reportedActivityDays) : {},
  };
  // Persist before the request so failed iOS requests retain the same anonymous ID.
  await SecureStore.setItemAsync(INSTALLATION_KEY, JSON.stringify(state));
  return state;
}

async function postEvent(baseUrl: string, state: InstallationState, eventType: 'installation' | 'activity') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/telemetry/installations`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: state.deviceId,
        platform: Platform.OS,
        appVersion: Application.nativeApplicationVersion ?? 'unknown',
        eventType,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Mobile telemetry failed with HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function report(baseUrl: string) {
  const state = await loadInstallation();
  const appVersion = Application.nativeApplicationVersion ?? 'unknown';
  if (state.reportedVersions[baseUrl] !== appVersion) {
    await postEvent(baseUrl, state, 'installation');
    state.reportedVersions[baseUrl] = appVersion;
    await SecureStore.setItemAsync(INSTALLATION_KEY, JSON.stringify(state));
  }
  // Match the server's Beijing day regardless of the phone's timezone.
  const day = new Date(Date.now() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  if (state.reportedActivityDays[baseUrl] === day) return;
  await postEvent(baseUrl, state, 'activity');
  state.reportedActivityDays[baseUrl] = day;
  await SecureStore.setItemAsync(INSTALLATION_KEY, JSON.stringify(state));
}

export function reportMobileActivity(baseUrlInput: string): Promise<void> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return Promise.resolve();
  const baseUrl = baseUrlInput.trim().replace(/\/+$/, '');
  // Serialize reads, requests and writes across server changes and overlapping lifecycle callbacks.
  const pending = reporting.then(() => report(baseUrl));
  reporting = pending.catch(() => undefined);
  return pending;
}
