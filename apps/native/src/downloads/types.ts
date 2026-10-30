import type { DownloadLocation, DownloadClient } from '../../../../shared/remote-chat/downloads';
import type { FileClient } from '../../../../shared/remote-chat/fileDownload';
import type { ConnectionMode } from '../../../../shared/remote-chat/protocol';

export interface DownloadSource extends DownloadLocation {
  attachment?: import('../../../../shared/lounge/attachments').LoungeAttachment;
  owner: string;
  deviceId: string;
  deviceName: string;
  path: string;
  gitCommit?: string;
  preview?: import('../../../../shared/remote-chat/downloads').PreviewKind;
}
export interface DownloadTask {
  id: string;
  source: DownloadSource;
  name: string;
  status: 'queued' | 'preparing' | 'downloading' | 'verifying' | 'saving' | 'paused' | 'completed' | 'failed';
  received: number;
  size: number;
  bytesPerSecond?: number;
  createdAt: number;
  completedAt?: number;
  message: string;
  uri?: string;
  cacheUri?: string;
  exported?: boolean;
  mimeType?: string;
  revision?: string;
  readyToSave?: boolean;
  savedBytes?: number;
  preparation?: import('../../../../shared/remote-chat/archiveDownload').ArchiveProgress;
}
export interface DownloadConnection {
  owner: string;
  deviceId: string;
  deviceName: string;
  ready: boolean;
  mode: ConnectionMode;
  windowSize: number;
  threadId?: string;
  cwd?: string;
  client: DownloadClient;
  files: FileClient;
  projectBrowser?: import('../../../../shared/project-browser/protocol').ProjectBrowserClient;
}
export interface DownloadRequest {
  requestId: string;
  taskId: string;
  source: DownloadSource;
  operation: 'open' | 'read' | 'close' | 'bulkRead' | 'bulkCancel' | 'cancelOpen';
  remoteId: string;
  offset: number;
  length: number;
  epoch?: string; manifestId?: string; block?: number; granted?: number; requestNumber?: number;
}
export interface DownloadNative {
  preparationProgress?: (requestId: string, progress: string) => Promise<void>;
  bulkBinaryAvailable?: boolean;
  manifestPage?: (id: string, page: string) => Promise<void>;
  invalidateBulk?: (owner: string, deviceId: string) => Promise<void>;
  list: () => Promise<string>;
  enqueue: (source: string) => Promise<string>;
  previewText: (id: string) => Promise<string>;
  previewUri: (id: string) => Promise<string>;
  discardPreview: (id: string) => Promise<void>;
  exportImage: (id: string) => Promise<void>;
  share: (id: string) => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  delete: (id: string) => Promise<void>;
  connection: (owner: string, deviceId: string, windowSize: number) => Promise<void>;
  accept: (id: string, result: string | null, failed: boolean) => Promise<boolean>;
}
