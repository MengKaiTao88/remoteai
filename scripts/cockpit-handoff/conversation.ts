import { createHash } from 'node:crypto';
import { summarizeTools } from '../../shared/conversation/toolDetails';
import { defaultText } from '../../shared/localization/messages';
import type { GuiEvent } from '../../shared/conversation/types';
import { CONNECTION_ERRORS } from '../../shared/remote-chat/connectionErrors';
import { chatHandshake, validateChatHandshake } from '../../shared/remote-chat/handshake';
import { parseHistoryWindow, sliceHistory } from '../../shared/remote-chat/historyPage';
import { HISTORY_CHANGED, historyDelta, parseHistoryVersion } from '../../shared/remote-chat/historySync';
import { PROJECT_LIST_OPERATION, PROJECT_SELECT_OPERATION } from '../../shared/remote-chat/projects';
import { object, type RpcRequest, type RpcResponse } from '../../shared/remote-chat/protocol';
import type { SidebarSnapshot } from '../../shared/remote-chat/sidebar';
import { NativeComposer } from './composer';
import { approvals, modelSettings, projectThread, type NativeView } from './projection';
import type { NativeGateway } from './nativeProcess';

const POLL_MS = 1250;
const RPC_CACHE_SIZE = 64;
const MAX_TEXT_LENGTH = 100_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const unsupported = () => new Error(defaultText('client.errors.thisOperationIsNotSupportedByThisClient'));
type Request = Record<string, unknown>;

function sidebar(pins: string[]): SidebarSnapshot {
  return { pins, threads: {}, readState: {}, revision: Date.now() };
}

function thread(value: unknown) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(CONNECTION_ERRORS.invalid);
  return value.toLowerCase();
}

const composerScope = (value: unknown) => value == null ? null : thread(value);

export function submissionId(threadId: string, requestId: string) {
  const bytes = createHash('sha256').update(JSON.stringify([threadId, requestId])).digest();
  bytes[6] = (bytes[6] & 15) | 0x80;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export class ConversationViewer {
  private readonly composer: NativeComposer;
  private threadId?: string;
  private sequence?: number;
  private connected?: boolean;
  private waiting = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<string, GuiEvent>();
  private readonly requests = new Map<string, { fingerprint: string; reply: Promise<RpcResponse> }>();

  constructor(private readonly native: NativeGateway, private readonly session: string,
    private readonly emit: (event: GuiEvent) => void) {
    this.composer = new NativeComposer(native);
  }

  execute(request: RpcRequest): Promise<RpcResponse> {
    const id = request.id;
    if (typeof id !== 'string' || id.length > 160) return Promise.resolve({ kind: 'response', id: '',
      error: CONNECTION_ERRORS.invalid });
    const fingerprint = JSON.stringify(request);
    const prior = this.requests.get(id);
    if (prior) return prior.fingerprint === fingerprint ? prior.reply
      : Promise.resolve({ kind: 'response', id, error: CONNECTION_ERRORS.invalid });
    const reply = this.run(request).then(data => ({ kind: 'response' as const, id, data }),
      (error: unknown) => ({ kind: 'response' as const, id, error: error instanceof Error
        ? error.message : CONNECTION_ERRORS.configuration }));
    if (this.requests.size >= RPC_CACHE_SIZE) {
      const oldest = this.requests.keys().next().value;
      if (oldest !== undefined) this.requests.delete(oldest);
    }
    this.requests.set(id, { fingerprint, reply });
    return reply;
  }

  close() { this.select(undefined); this.requests.clear(); }

  private select(threadId: string | undefined) {
    if (this.threadId === threadId) return;
    clearTimeout(this.timer);
    this.threadId = threadId;
    this.sequence = undefined;
    this.waiting = false;
    this.connected = undefined;
    this.pending.clear();
    if (threadId) this.schedule(threadId);
  }

  private schedule(threadId: string) {
    if (this.threadId === threadId) this.timer = setTimeout(() => void this.poll(threadId), POLL_MS);
  }

  private async poll(threadId: string) {
    try {
      const view = await this.native.call<NativeView>('view', { threadId, sequence: this.sequence });
      if (this.threadId !== threadId) return;
      if (this.connected && !view.connected) {
        this.waiting = true;
        this.emit({ method: 'connection/closed', params: { threadId } });
      }
      if (view.connected) this.waiting = false;
      this.connected = view.connected;
      if (view.id && view.sequence !== this.sequence) {
        this.sequence = view.sequence;
        this.updateApprovals(view);
        this.emit({ method: HISTORY_CHANGED, params: { threadId } });
      }
    } catch { /* The next poll or synchronization will reconcile the same view. */ }
    finally { this.schedule(threadId); }
  }

  private updateApprovals(view: NativeView) {
    const next = new Map(approvals(view).map(({ event }) => [String(event.id), event]));
    for (const [id, event] of next) if (!this.pending.has(id)) this.emit(event);
    for (const id of this.pending.keys()) {
      if (!next.has(id)) this.emit({ method: 'serverRequest/resolved', params: { requestId: id } });
    }
    this.pending.clear();
    for (const [id, event] of next) this.pending.set(id, event);
  }

  private async connect(body: unknown) {
    validateChatHandshake(body);
    if (this.threadId && this.waiting) await this.resume(this.threadId);
    const events = [...this.pending.values()];
    return body === undefined ? events : { ...chatHandshake, approvals: events, conversationViewsV1: true };
  }

  private async resume(threadId: string) {
    const view = await this.native.call<NativeView>('view', { threadId });
    if (view.connected) return {};
    const status = await this.native.call<{ connected: boolean }>('resume', { threadId });
    if (!status.connected) throw new Error(CONNECTION_ERRORS.guiDisconnected);
    return {};
  }

  private async run(request: RpcRequest) {
    if (request.method === 'connect') return this.connect(request.body);
    const body = object(request.body);
    if (request.method === 'respond') return this.respond(body);
    if (request.method !== 'request') throw unsupported();
    switch (body.operation) {
      case 'list': return this.list(body);
      case 'viewThread': this.select(body.threadId === null ? undefined : thread(body.threadId)); return {};
      case 'read': case 'syncHistory': return this.history(body);
      case 'toolDetails': case 'processDetails': return this.details(body);
      case 'models': case 'modelsRefresh': return this.models(body);
      case 'composerSet': return this.composer.write(composerScope(body.threadId), body.settings);
      case PROJECT_LIST_OPERATION: return this.native.call('projects');
      case PROJECT_SELECT_OPERATION: return this.draftProject(body);
      case 'guiAccountsRead': return { choices: [], selection: { kind: 'none' }, running: false };
      case 'start': return this.start(body, request.id);
      case 'rename': return this.native.call('rename', { threadId: thread(body.threadId), name: body.name });
      case 'archive': case 'unarchive': return this.archive(body, request.id);
      case 'threadPin': return this.pin(body);
      case 'resume': return this.resume(thread(body.threadId));
      case 'send': case 'steer': return this.send(body, request.id);
      case 'interrupt': return this.native.call('interrupt', { threadId: thread(body.threadId), turnId: body.turnId });
      case 'threadRead': return {};
      default: throw unsupported();
    }
  }

  private async list(body: Request) {
    const offset = typeof body.cursor === 'string' && /^\d{1,6}$/.test(body.cursor) ? Number(body.cursor) : 0;
    const limit = Number.isSafeInteger(body.limit) ? Math.min(100, Math.max(1, Number(body.limit))) : 50;
    const { rows, pins } = await this.native.call<{ rows: NativeView[]; pins: string[] }>('list', { offset, limit: limit + 1,
      search: typeof body.search === 'string' ? body.search.slice(0, 200) : '', archived: body.archived === true });
    return { data: rows.slice(0, limit).map(row => ({ ...projectThread(row), turns: undefined })),
      nextCursor: rows.length > limit && offset + limit <= 100_000 ? String(offset + limit) : null, sidebar: sidebar(pins) };
  }

  private async draftProject(body: Request) {
    if (body.threadId != null) throw unsupported();
    if (typeof body.cwd !== 'string' || body.cwd.length > 4_096) throw new Error(CONNECTION_ERRORS.invalid);
    return this.native.call('project', { cwd: body.cwd });
  }

  private async archive(body: Request, rpcId: string) {
    const threadId = thread(body.threadId);
    const result = await this.native.call<{ status: string; reason?: string }>('archive', {
      threadId, archived: body.operation === 'archive', requestId: submissionId(threadId, `${this.session}:${rpcId}`),
    });
    if (result.status === 'rejected' && result.reason) throw new Error(result.reason);
    if (result.status !== 'confirmed') throw new Error(CONNECTION_ERRORS.configuration);
    return result;
  }

  private async pin(body: Request) {
    const pins = await this.native.call<string[]>('pin', { threadId: thread(body.threadId), pinned: body.pinned });
    return sidebar(pins);
  }

  private async history(body: Request) {
    const threadId = thread(body.threadId);
    if (!this.threadId) this.select(threadId);
    let result = await this.native.call<NativeView>('view', { threadId });
    for (let attempt = 0; result.loadingHistory === true && attempt < 12; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      result = await this.native.call<NativeView>('view', { threadId });
    }
    const project = (view: NativeView) => body.deferToolDetails === true
      ? summarizeTools(projectThread(view)) : projectThread(view);
    if (body.operation === 'read') return { thread: project(result) };
    const window = parseHistoryWindow(body.window);
    let { thread: visible, page } = sliceHistory(project(result), window);
    if (window.older && !page.hasMore && result.historyComplete === false) {
      result = await this.native.call<NativeView>('olderHistory', { threadId });
      ({ thread: visible, page } = sliceHistory(project(result), window));
    }
    return { ...historyDelta(visible, parseHistoryVersion(body.known)),
      page: { ...page, hasMore: page.hasMore || result.historyComplete === false } };
  }

  private async details(body: Request) {
    const threadId = thread(body.threadId);
    const view = await this.native.call<NativeView>('view', { threadId });
    const items = projectThread(view).turns?.find(turn => turn.id === body.turnId)?.items ?? [];
    const first = items.findIndex(item => item.id === body.itemId);
    if (first < 0) throw new Error(CONNECTION_ERRORS.invalid);
    if (body.operation === 'toolDetails') return { item: items[first] };
    const last = items.findIndex(item => item.id === body.endItemId);
    if (last < first) throw new Error(CONNECTION_ERRORS.invalid);
    return { items: items.slice(first, last + 1) };
  }

  private async models(body: Request) {
    const composer = await this.composer.read(composerScope(body.threadId), body.operation === 'modelsRefresh');
    return { data: composer.models, nextCursor: null, composer };
  }

  private async start(body: Request, rpcId: string) {
    if (body.cwd != null && (typeof body.cwd !== 'string' || body.cwd.length > 4_096)) {
      throw new Error(CONNECTION_ERRORS.invalid);
    }
    const result = await this.native.call<NativeView>('start', { cwd: body.cwd ?? null,
      requestId: submissionId(this.session, rpcId), title: defaultText('client.chat.newChat') });
    return { thread: projectThread(result) };
  }

  private async send(body: Request, rpcId: string) {
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_TEXT_LENGTH) {
      throw new Error(CONNECTION_ERRORS.invalid);
    }
    if ([body.images, body.skills, body.attachments].some(value => Array.isArray(value) && value.length)) {
      throw unsupported();
    }
    const threadId = thread(body.threadId);
    const clientId = typeof body.clientId === 'string' && body.clientId.length <= 160
      ? body.clientId : `${this.session}:${rpcId}`;
    const mode = body.operation === 'steer' ? 'steer' : 'send';
    let view = await this.native.call<NativeView>('view', { threadId });
    if (!view.connected && mode === 'send') {
      await this.resume(threadId);
      view = await this.native.call<NativeView>('view', { threadId });
    }
    if (!view.connected) throw new Error(CONNECTION_ERRORS.guiDisconnected);
    const settings = modelSettings(view);
    if ((body.model && body.model !== settings.model) || (body.effort && body.effort !== settings.effort)) {
      throw new Error(CONNECTION_ERRORS.configuration);
    }
    const result = await this.native.call<{ status: string }>('send', { threadId, text: body.text,
      mode, turnId: body.turnId, submissionId: submissionId(threadId, clientId) });
    if (result.status !== 'accepted') throw new Error(CONNECTION_ERRORS.guiTimeout);
    return {};
  }

  private async respond(body: Request) {
    if (!this.threadId || typeof body.id !== 'string') throw new Error(CONNECTION_ERRORS.invalid);
    const view = await this.native.call<NativeView>('view', { threadId: this.threadId });
    const approval = approvals(view).find(row => row.event.id === body.id);
    if (!approval) throw new Error(CONNECTION_ERRORS.invalid);
    const answers = body.answers === undefined ? undefined : object(body.answers);
    const response = answers ? { answers: Object.fromEntries(Object.entries(answers)
      .map(([id, answer]) => [id, object(answer).answers])) }
      : { decision: body.decision };
    if (!answers && !['accept', 'decline', 'cancel'].includes(String(body.decision))) {
      throw new Error(CONNECTION_ERRORS.invalid);
    }
    await this.native.call('respond', { threadId: this.threadId, requestId: approval.nativeId, response });
    return {};
  }
}
