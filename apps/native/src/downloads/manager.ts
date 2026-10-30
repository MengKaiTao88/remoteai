import { t } from '../i18n';
import { DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import type { AuthSession } from '../types';
import type { DownloadConnection, DownloadNative, DownloadRequest, DownloadSource, DownloadTask } from './types';
import { forwardDownloadRequest } from './transport';
import type { IosLoungeDownloads } from './iosLoungeDownloads';

export const downloadOwner = (session: AuthSession) => JSON.stringify([session.baseUrl, session.email]);
const native: DownloadNative | undefined = NativeModules.FileDownloads;
let tasks: DownloadTask[] = [];
let connection: DownloadConnection | undefined;
const loungeConnections = new Map<string, Pick<DownloadConnection, 'owner' | 'deviceId' | 'ready' | 'client'>>();
const connectionForSource = (source: DownloadSource) => source.attachment ? loungeConnections.get(source.owner)
  : connection?.owner === source.owner && connection.deviceId === source.deviceId ? connection : undefined;
let error = '';
let initialized: Promise<void> | undefined;
let bulkTransport: ReturnType<NonNullable<DownloadConnection['client']['bulk']>['transport']>;
let unlistenBulk: (() => void) | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
let ios: IosLoungeDownloads | undefined;
const requireNative = () => {
  if (!native) throw new Error(t("client.mobile.installTheLatestAndroidAppToManageDownloads"));
  return native;
};

function observeBulk(value?: DownloadConnection) {
  const transport = value?.client.bulk?.transport();
  if (transport === bulkTransport) return;
  unlistenBulk?.(); bulkTransport = transport;
  unlistenBulk = transport?.onInvalidated(() => {
    if (!value) return;
    void native?.invalidateBulk?.(value.owner, value.deviceId)
      .catch(() => { error = t("client.mobile.downloadInterruptedResumeItLater"); emit(); });
  });
}

export const downloadManager = {
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot: () => tasks,
  connection: () => connection,
  connectionForSource,
  registerLounge(value: Pick<DownloadConnection, 'owner' | 'deviceId' | 'ready' | 'client'>) {
    const previous = loungeConnections.get(value.owner);
    if (previous?.ready === value.ready && previous.client === value.client) return;
    loungeConnections.set(value.owner, value);
    tasks = [...tasks];
    emit();
    void this.initialize().then(() => {
      if (loungeConnections.get(value.owner) !== value) return;
      if (ios) { ios.bind(value.owner, value); return; }
      return native?.connection(value.owner, value.deviceId, value.ready ? 1 : 0);
    })
      .catch(() => { error = t('client.lounge.fileUnavailable'); emit(); });
  },
  unbindLounge(owner: string) {
    const previous = loungeConnections.get(owner);
    loungeConnections.delete(owner); tasks = [...tasks]; emit();
    ios?.bind(owner);
    if (previous) void native?.connection(owner, previous.deviceId, 0)
      .catch(() => console.warn('Could not pause lounge downloads.'));
  },
  error: () => error,
  initialize() {
    if (initialized) return initialized;
    if (Platform.OS === 'ios') return initialized = import('./iosLoungeDownloads').then(async module => {
      ios ??= new module.IosLoungeDownloads(value => { tasks = value; emit(); });
      await ios.initialize();
    }).catch(() => {
      initialized = undefined; error = t('client.mobile.couldNotLoadDownloadHistory'); emit();
    });
    initialized = Promise.resolve().then(async () => {
      const bridge = requireNative();
      const changed = DeviceEventEmitter.addListener('downloadTasksChanged', (json: string) => {
        tasks = JSON.parse(json) as DownloadTask[]; emit();
      });
      const requests = DeviceEventEmitter.addListener('downloadRequest', (json: string) => {
        const request = JSON.parse(json) as DownloadRequest;
        const current = connectionForSource(request.source);
        const client = current?.owner === request.source.owner && current.deviceId === request.source.deviceId
          ? current.client : undefined;
        void forwardDownloadRequest({ request, client, native: bridge })
          .catch(() => { error = t("client.mobile.downloadInterruptedResumeItLater"); emit(); });
      });
      try { tasks = JSON.parse(await bridge.list()) as DownloadTask[]; error = ''; emit(); }
      catch (cause) { changed.remove(); requests.remove(); throw cause; }
    }).catch(cause => {
      initialized = undefined;
      error = cause instanceof Error ? cause.message : t("client.mobile.couldNotLoadDownloadHistory"); emit();
    });
    return initialized;
  },
  bind(value: DownloadConnection) {
    observeBulk(value);
    const previous = connection;
    const sameSource = previous?.files === value.files && previous.owner === value.owner
      && previous.deviceId === value.deviceId;
    if (sameSource && previous.ready === value.ready && previous.mode === value.mode
      && previous.windowSize === value.windowSize
      && previous.threadId === value.threadId
      && previous.cwd === value.cwd && previous.deviceName === value.deviceName) return;
    connection = value; emit();
    if (sameSource && previous.ready === value.ready && previous.windowSize === value.windowSize) return;
    void this.initialize().then(() => {
      if (connection?.files === value.files && connection.ready === value.ready
        && connection.windowSize === value.windowSize) {
        return native?.connection(value.owner, value.deviceId, value.ready ? value.windowSize : 0);
      }
    })
      .catch(() => { error = t("client.mobile.couldNotConnectToDownloads"); emit(); });
  },
  unbind(files: DownloadConnection['files']) {
    if (connection?.files !== files) return;
    const previous = connection;
    // Pause before discarding the source. A new device must never receive an old device's read requests.
    connection = undefined; emit();
    observeBulk();
    void native?.connection(previous.owner, previous.deviceId, 0)
      .catch(() => console.warn('Could not checkpoint disconnected downloads.'));
  },
  async enqueue(source: DownloadSource) {
    await this.initialize();
    const current = connectionForSource(source);
    if (!current?.ready || current.owner !== source.owner || current.deviceId !== source.deviceId) {
      throw new Error(t("client.mobile.connectToThisComputerBeforeDownloading"));
    }
    if (!source.preview && Platform.OS === 'android' && Number(Platform.Version) < 29) {
      const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) throw new Error(t("client.mobile.allowFileStorageToStartDownloading"));
    }
    if (ios && source.attachment) return ios.enqueue(source);
    const id = await requireNative().enqueue(JSON.stringify(source));
    if (source.attachment && tasks.some(task => task.id === id && ['paused', 'failed'].includes(task.status))) {
      await requireNative().resume(id);
    }
    return id;
  },
  pause: (id: string) => ios ? ios.pause(id) : requireNative().pause(id),
  resume: (id: string) => ios ? ios.resume(id) : requireNative().resume(id),
  delete: (id: string) => ios ? ios.remove(id) : requireNative().delete(id),
  previewText: (id: string) => requireNative().previewText(id),
  previewUri: (id: string) => requireNative().previewUri(id),
  discardPreview: (id: string) => requireNative().discardPreview(id),
  async exportImage(id: string) {
    if (Platform.OS === 'android' && Number(Platform.Version) < 29) {
      const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) throw new Error(t("client.mobile.allowPhotoStorageAndTryAgain"));
    }
    await requireNative().exportImage(id);
  },
  async open(task: DownloadTask) {
    if (!task.uri || task.status !== 'completed') return;
    const uri = task.uri.startsWith('file://') ? decodeURI(task.uri.slice(7)) : task.uri;
    if (ios) { ReactNativeBlobUtil.ios.previewDocument(uri); return; }
    await ReactNativeBlobUtil.android.actionViewIntent(uri, task.mimeType || 'application/octet-stream');
  },
  async share(task: DownloadTask) {
    if (!task.uri || task.status !== 'completed') return;
    if (ios) { ReactNativeBlobUtil.ios.openDocument(decodeURI(task.uri.replace(/^file:\/\//, ''))); return; }
    await requireNative().share(task.id);
  },
};
