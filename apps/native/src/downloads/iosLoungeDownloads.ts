import ReactNativeBlobUtil from 'react-native-blob-util';
import Storage from 'expo-sqlite/kv-store';
import { randomUUID } from 'expo-crypto';
import { transferFileChunks, validateFileInfo } from '../../../../shared/remote-chat/fileDownload';
import type { DownloadClient } from '../../../../shared/remote-chat/downloads';
import type { DownloadSource, DownloadTask } from './types';

const INDEX = 'lounge-downloads:v1';
const MAX_TASKS = 500;
const MAX_ACTIVE = 2;
const DIRECTORY = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/lounge-downloads`;
const { fs } = ReactNativeBlobUtil;
interface Connection { ready: boolean; client: DownloadClient }

/** iOS keeps attachment tasks in app storage, using the same encrypted ranges and download-page actions. */
export class IosLoungeDownloads {
  private tasks: DownloadTask[] = [];
  private initialized?: Promise<void>;
  private writes = Promise.resolve();
  private connections = new Map<string, Connection>();
  private flights = new Map<string, { abort: AbortController; done: Promise<void> }>();
  constructor(private readonly changed: (tasks: DownloadTask[]) => void) {}
  initialize = () => this.initialized ??= (async () => {
    if (!await fs.exists(DIRECTORY)) await fs.mkdir(DIRECTORY);
    const json = await Storage.getItem(INDEX);
    this.tasks = json ? (JSON.parse(json) as DownloadTask[]).map(task => ({ ...task,
      status: task.status === 'completed' ? 'completed' : 'paused', bytesPerSecond: undefined })) : [];
    this.changed(this.tasks);
  })();
  private persist() {
    const json = JSON.stringify(this.tasks);
    const write = this.writes.then(() => Storage.setItem(INDEX, json));
    this.writes = write.catch(() => {}); // Each operation handles its own persistence error.
    this.changed([...this.tasks]); return write;
  }
  bind(owner: string, connection?: Connection) {
    if (connection) this.connections.set(owner, connection); else this.connections.delete(owner);
    if (!connection?.ready) this.tasks.filter(task => task.source.owner === owner)
      .forEach(task => this.flights.get(task.id)?.abort.abort());
    this.schedule();
  }
  async enqueue(source: DownloadSource) {
    await this.initialize();
    const existing = this.tasks.find(task => task.source.owner === source.owner
      && task.source.attachment?.id === source.attachment?.id && task.status !== 'completed');
    if (existing) { await this.resume(existing.id); return existing.id; }
    if (!source.attachment || this.tasks.length >= MAX_TASKS) throw new Error('client.lounge.downloadFailed');
    const task: DownloadTask = { id: randomUUID(), source, name: source.path, status: 'queued',
      received: 0, size: 0, createdAt: Date.now(), message: '' };
    this.tasks.push(task); await this.persist(); this.schedule(); return task.id;
  }
  async pause(id: string) {
    const flight = this.flights.get(id);
    if (flight) { flight.abort.abort(); await flight.done; }
    const task = this.tasks.find(item => item.id === id);
    if (task?.status === 'queued') { task.status = 'paused'; await this.persist(); }
  }
  async resume(id: string) {
    const task = this.tasks.find(item => item.id === id);
    if (!task || this.flights.has(id) || task.status === 'completed') return;
    task.status = 'queued'; task.message = ''; await this.persist(); this.schedule();
  }
  async remove(id: string) {
    await this.pause(id);
    const task = this.tasks.find(item => item.id === id);
    if (!task || !/^[a-f\d-]{36}$/i.test(id)) return;
    const directory = `${DIRECTORY}/${id}`;
    if (await fs.exists(directory)) await fs.unlink(directory);
    this.tasks = this.tasks.filter(item => item.id !== id); await this.persist();
  }
  private schedule() {
    for (const task of this.tasks) {
      if (this.flights.size >= MAX_ACTIVE) return;
      const connection = this.connections.get(task.source.owner);
      if (!connection?.ready || task.status !== 'queued' || this.flights.has(task.id)) continue;
      const abort = new AbortController();
      const done = Promise.resolve().then(() => this.run(task, connection.client, abort.signal)).finally(() => {
        this.flights.delete(task.id); this.schedule();
      });
      this.flights.set(task.id, { abort, done });
    }
  }
  private async run(task: DownloadTask, client: DownloadClient, signal: AbortSignal) {
    let remoteId: string | undefined;
    try {
      task.status = 'preparing'; await this.persist();
      const info = await client.open({ ...task.source, transferId: task.id }, { signal });
      remoteId = info.id; validateFileInfo(info, undefined, client.checkSize);
      const directory = `${DIRECTORY}/${task.id}`, partial = `${directory}/.partial`;
      if (!await fs.exists(directory)) await fs.mkdir(directory);
      const resume = await fs.exists(partial) && !!info.revision && info.revision === task.revision
        && info.size === task.size && Number((await fs.stat(partial)).size) === task.received;
      if (!resume) { await fs.writeFile(partial, '', 'base64'); task.received = 0; }
      Object.assign(task, { size: info.size, revision: info.revision, mimeType: info.mimeType,
        name: info.name, status: 'downloading', message: '' });
      await this.persist();
      const started = Date.now(), initial = task.received;
      await transferFileChunks({ client, threadId: task.id, info, signal, offset: task.received, checkSize: client.checkSize,
        write: async (chunk, received) => {
          await fs.appendFile(partial, chunk.data, 'base64'); task.received = received;
          task.bytesPerSecond = (received - initial) * 1000 / Math.max(1, Date.now() - started);
          await this.persist();
        } });
      const destination = `${directory}/${info.name}`;
      await fs.mv(partial, destination);
      Object.assign(task, { status: 'completed', uri: `file://${encodeURI(destination)}`, completedAt: Date.now(),
        bytesPerSecond: undefined });
      await this.persist();
    } catch {
      Object.assign(task, { status: signal.aborted ? 'paused' : 'failed', bytesPerSecond: undefined,
        message: signal.aborted ? '' : 'client.lounge.fileUnavailable' });
      await this.persist().catch(() => console.warn('Could not checkpoint lounge download.'));
    } finally {
      if (remoteId) await client.close(task.id, remoteId).catch(() => console.warn('Attachment handle will expire.'));
    }
  }
}
