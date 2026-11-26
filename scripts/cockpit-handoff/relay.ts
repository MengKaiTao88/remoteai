import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { ChatLink } from '../../shared/remote-chat/link';
import { keyPair } from '../../shared/remote-chat/cipher';
import { setChatPolicy } from '../../shared/remote-chat/policy';
import { parseMessage, type Signal } from '../../shared/remote-chat/protocol';
import { RelayQuota } from '../../shared/remote-chat/relayUsage';
import { ConversationViewer } from './conversation';
import { endpoint, type Configuration } from './configuration';
import type { NativeGateway } from './nativeProcess';

const MAX_SESSIONS = 12;
const MAX_SIGNAL_LENGTH = 1024 * 1024;
const LEASE_REFRESH_MS = 50 * 60_000;
const AUTH_TIMEOUT_MS = 10_000;
const KEY = /^[a-f0-9]{64}$/i;
const SESSION = /^[a-z0-9-]{1,96}$/i;
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
type Path = 'device-chat' | 'device-switch';
type Message = Record<string, unknown>;
type Report = (stage: string, online?: boolean) => void;

function identitySigner(seed: string) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed, 'base64')]),
    format: 'der', type: 'pkcs8' });
  const publicKey = privateKey.export({ format: 'jwk' }).x;
  if (typeof publicKey !== 'string') throw new Error('HOST_IDENTITY_INVALID');
  const key = Buffer.from(publicKey, 'base64url').toString('hex');
  return (sessionId: string, ephemeral: string) => ({ key,
    signature: sign(null, Buffer.from(`codex-switch-host-v1:${sessionId}:${ephemeral}`), privateKey).toString('hex') });
}

interface Session {
  link: ChatLink;
  viewer: ConversationViewer;
  quota: RelayQuota;
  resumeToken: string;
  lease?: ReturnType<typeof setTimeout>;
}

export class DeviceRelay {
  private readonly sessions = new Map<string, Session>();
  private readonly sockets = new Map<Path, WebSocket>();
  private readonly retry = new Map<Path, ReturnType<typeof setTimeout>>();
  private readonly authenticated = new Set<Path>();
  private readonly identity;
  private authRenewal = false;
  private stopped = false;

  constructor(private readonly configuration: Configuration, private readonly native: NativeGateway,
    private readonly version: string, private readonly report: Report) {
    this.identity = identitySigner(configuration.identity);
  }

  start() { this.connect('device-chat'); this.connect('device-switch'); }

  stop() {
    this.stopped = true;
    for (const timer of this.retry.values()) clearTimeout(timer);
    for (const socket of this.sockets.values()) socket.close();
    for (const id of this.sessions.keys()) this.release(id);
  }

  private send(message: object) {
    const socket = this.sockets.get('device-chat');
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('RELAY_OFFLINE');
    socket.send(JSON.stringify(message));
  }

  private release(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    clearTimeout(session.lease);
    session.viewer.close();
    session.link.close();
  }

  private markAuthenticated(path: Path) {
    this.authenticated.add(path);
    if (this.authenticated.size === 2) this.report('online', true);
    else this.report(`${path}-online`);
  }

  private lease(id: string, expiresAt: unknown) {
    const row = this.sessions.get(id);
    if (!row || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return;
    clearTimeout(row.lease);
    row.link.renew(expiresAt);
    row.lease = setTimeout(() => this.release(id), Math.max(0, Math.min(expiresAt - Date.now(), 3_660_000)));
  }

  private open(id: string, message: Message) {
    if (this.sessions.has(id) || this.sessions.size >= MAX_SESSIONS || message.assistanceId) return;
    const publicKey = message.publicKey;
    if (typeof publicKey !== 'string' || !KEY.test(publicKey)
      || typeof message.expiresAt !== 'number' || message.expiresAt <= Date.now()) return;
    const keys = keyPair(randomBytes);
    const viewer = new ConversationViewer(this.native, id, event => {
      void link.send({ kind: 'event', event }).catch(() => this.release(id));
    });
    const link = new ChatLink({ sessionId: id, desktop: true, secret: keys.secret, publicKey,
      transportVersion: Number(message.transportVersion), iceServers: [],
      relayBuffered: () => this.sockets.get('device-chat')?.bufferedAmount ?? 0,
      createPeer: () => ({ offer: async () => {}, accept: async () => {}, close: () => {} }),
      signal: frame => this.send(frame), mode: mode => { if (mode === 'offline') this.release(id); },
      error: () => this.release(id), message: request => {
        if (request.kind !== 'request') return;
        void viewer.execute(request).then(response => link.send(response)).catch(() => this.release(id));
      } });
    this.sessions.set(id, { link, viewer, quota: new RelayQuota(), resumeToken: String(message.resumeToken ?? '') });
    this.lease(id, message.expiresAt);
    this.send({ type: 'signal', sessionId: id, payload: { kind: 'key', key: keys.publicKey,
      identity: this.identity(id, keys.publicKey) } });
  }

  private async receive(message: Message) {
    if (message.type === 'chat-policy') {
      setChatPolicy(message.policy);
      this.authRenewal = message.authRenewal === true;
      this.markAuthenticated('device-chat');
      return;
    }
    const id = message.sessionId;
    if (typeof id !== 'string' || !SESSION.test(id)) return;
    if (message.type === 'peer-open') { this.open(id, message); return; }
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.quota.receive(message)) session.link.setRelayQuotaBlocked(session.quota.blocked);
    switch (message.type) {
      case 'resumed':
        this.lease(id, message.expiresAt);
        if (message.renewed !== true) session.link.setRelayAvailable(true);
        break;
      case 'peer-offline': session.link.setRelayAvailable(false); break;
      case 'signal': await session.link.acceptSignal(message.payload as Signal); break;
      case 'relay-ready': session.link.enableRelay(); break;
      case 'relay': if (typeof message.payload === 'string') session.link.receive(message.payload); break;
      case 'peer-close': this.release(id); break;
    }
  }

  private authenticate(socket: WebSocket, path: Path) {
    const { credential, deviceId, name } = this.configuration;
    const sessionInfo = [...this.sessions].filter(([, row]) => row.link.resumable && row.resumeToken)
      .map(([sessionId, row]) => ({ sessionId, resumeToken: row.resumeToken }));
    socket.send(JSON.stringify({ type: 'authenticate', role: 'desktop', accessToken: credential, deviceId,
      name, platform: 'Windows', appVersion: this.version, transportVersion: 2,
      ...(path === 'device-chat' ? { sessions: sessionInfo } : {}) }));
  }

  private connect(path: Path, attempt = 0) {
    if (this.stopped) return;
    const url = endpoint(this.configuration.baseUrl, path);
    url.protocol = 'wss:';
    const socket = new WebSocket(url);
    this.sockets.set(path, socket);
    let incoming = Promise.resolve();
    let deadline = setTimeout(() => socket.close(), AUTH_TIMEOUT_MS);
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const refreshLease = () => {
      if (path === 'device-chat' && this.authRenewal) {
        socket.send(JSON.stringify({ type: 'renew-auth', accessToken: this.configuration.credential }));
        deadline = setTimeout(() => socket.close(), AUTH_TIMEOUT_MS);
      } else socket.close(1000);
    };
    socket.onopen = () => this.authenticate(socket, path);
    socket.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > MAX_SIGNAL_LENGTH) { socket.close(); return; }
      incoming = incoming.then(async () => {
        const message = parseMessage(event.data);
        if (['chat-policy', 'authenticated', 'auth-renewed'].includes(String(message.type))) {
          clearTimeout(deadline);
          clearTimeout(refresh);
          refresh = setTimeout(refreshLease, LEASE_REFRESH_MS);
          attempt = 0;
        }
        if (path === 'device-chat') await this.receive(message);
        else if (message.type === 'authenticated') this.markAuthenticated('device-switch');
      }).catch(() => socket.close());
    };
    socket.onerror = () => socket.close();
    socket.onclose = event => {
      clearTimeout(deadline);
      clearTimeout(refresh);
      this.authenticated.delete(path);
      if (path === 'device-chat') this.disconnectChat(event.code);
      if (this.stopped) return;
      this.report(`${path}-retry-${event.code}`, false);
      const delay = event.code === 4008 ? 30_000 : Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
      this.retry.set(path, setTimeout(() => this.connect(path, attempt + 1), delay));
    };
  }

  private disconnectChat(code: number) {
    this.authRenewal = false;
    for (const [id, row] of this.sessions) {
      if (code === 4000 || code === 4001 || !row.link.resumable) this.release(id);
      else row.link.setRelayAvailable(false);
    }
  }
}
