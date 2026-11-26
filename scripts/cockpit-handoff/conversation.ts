import { createHash } from 'node:crypto';
import { defaultText } from '../../shared/localization/messages';
import type { GuiEvent } from '../../shared/conversation/types';
import { CONNECTION_ERRORS } from '../../shared/remote-chat/connectionErrors';
import { DEFAULT_COMPOSER } from '../../shared/remote-chat/composer';
import { chatHandshake, validateChatHandshake } from '../../shared/remote-chat/handshake';
import { parseHistoryWindow, sliceHistory } from '../../shared/remote-chat/historyPage';
import { HISTORY_CHANGED, historyDelta, parseHistoryVersion } from '../../shared/remote-chat/historySync';
import { object, type RpcRequest, type RpcResponse } from '../../shared/remote-chat/protocol';
import { approvals, modelSettings, projectModels, projectThread, type NativeView } from './projection';
import type { NativeGateway } from './nativeProcess';

const POLL_MS = 1250;
const RPC_CACHE_SIZE = 64;
const MAX_TEXT_LENGTH = 100_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const unsupported = () => new Error(defaultText('client.errors.thisOperationIsNotSupportedByThisClient'));
type Request = Record<string, unknown>;

function thread(value: unknown) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(CONNECTION_ERRORS.invalid);
  return value.toLowerCase();
}

export function submissionId(threadId: string, requestId: string) {
  const bytes = createHash('sha256').update(JSON.stringify([threadId, requestId])).digest();
  bytes[6] = (bytes[6] & 15) | 0x80;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export class ConversationViewer {
  private threadId?: string;
  private sequence?: number;
  private connected?: boolean;
  private waiting = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<string, GuiEvent>();
  private readonly requests = new Map<string, { fingerprint: string; reply: Promise<RpcResponse> }>();

  constructor(private readonly native: NativeGateway, private readonly session: string,
    private readonly emit: (event: GuiEvent) => void) {}

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
      case 'models': case 'modelsRefresh': return this.models(body);
      case 'guiAccountsRead': return { choices: [], selection: { kind: 'none' }, running: false };
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
    const rows = await this.native.call<NativeView[]>('list', { offset, limit: limit + 1,
      search: typeof body.search === 'string' ? body.search.slice(0, 200) : '', archived: body.archived === true });
    return { data: rows.slice(0, limit).map(row => ({ ...projectThread(row), turns: undefined })),
      nextCursor: rows.length > limit && offset + limit <= 100_000 ? String(offset + limit) : null };
  }

  private async history(body: Request) {
    const threadId = thread(body.threadId);
    if (!this.threadId) this.select(threadId);
    let result = await this.native.call<NativeView>('view', { threadId });
    for (let attempt = 0; result.loadingHistory === true && attempt < 12; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      result = await this.native.call<NativeView>('view', { threadId });
    }
    const current = projectThread(result);
    if (body.operation === 'read') return { thread: current };
    const { thread: visible, page } = sliceHistory(current, parseHistoryWindow(body.window));
    return { ...historyDelta(visible, parseHistoryVersion(body.known)), page };
  }

  private async models(body: Request) {
    const threadId = body.threadId == null ? null : thread(body.threadId);
    const id = threadId ?? this.threadId;
    if (!id) return { data: [], nextCursor: null, composer: { models: [], threadId, settings: DEFAULT_COMPOSER,
      revision: Date.now() } };
    const view = await this.native.call<NativeView>('view', { threadId: id });
    const settings = modelSettings(view);
    const catalog = await this.native.call<{ models?: unknown }>('models', { threadId: id }).catch(() => ({}));
    const models = projectModels('models' in catalog ? catalog.models : [], settings);
    return { data: models, nextCursor: null, composer: { models, settings, threadId, revision: Date.now() } };
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
    const view = await this.native.call<NativeView>('view', { threadId });
    if (!view.connected) throw new Error(CONNECTION_ERRORS.guiDisconnected);
    const settings = modelSettings(view);
    if ((body.model && body.model !== settings.model) || (body.effort && body.effort !== settings.effort)) {
      throw new Error(CONNECTION_ERRORS.configuration);
    }
    const result = await this.native.call<{ status: string }>('send', { threadId, text: body.text,
      mode: body.operation === 'steer' ? 'steer' : 'send', turnId: body.turnId, submissionId: submissionId(threadId, clientId) });
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
