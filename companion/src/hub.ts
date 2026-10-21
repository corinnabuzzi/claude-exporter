import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CloseCode,
  PROTOCOL_VERSION,
  createNonce,
  isNonce,
  makeProof,
  mismatchReason,
  parseMessage,
  verifyProof,
  type Account,
  type CompanionMessage,
  type ErrorCode,
  type HelloMessage,
  type Operation,
  type ResponseMessage,
  type Via
} from '@claude-exporter/protocol';

// stops web pages, which can't fake Origin. Local programs can, which is what the handshake is for.
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i;
const HANDSHAKE_TIMEOUT = 5_000;

export interface BrowserInfo {
  id: string;
  browser: string;
  origin: string;
  extensionVersion: string;
  account: Account | null;
  connectedAt: number;
}

export type Rejection =
  | { kind: 'origin'; origin: string }
  | { kind: 'token'; origin: string; browser: string }
  | { kind: 'protocol'; origin: string; browser: string; theirs: number; ours: number };

export interface HubEvents {
  connected: [BrowserInfo];
  disconnected: [BrowserInfo];
  account: [BrowserInfo];
  rejected: [Rejection];
}

export interface HubOptions {
  token: string;
  port: number;
  host?: string;
  requestTimeout?: number;
  handshakeTimeout?: number;
}

export class HubError extends Error {
  code: ErrorCode | 'no_browser' | 'timeout' | 'disconnected';
  constructor(code: HubError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface RequestResult {
  via: Via;
  result: unknown;
  browser: BrowserInfo;
}

interface Client {
  info: BrowserInfo;
  ws: WebSocket;
}

interface Pending {
  clientId: string;
  resolve: (value: RequestResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Stage =
  | { name: 'hello' }
  | { name: 'proof'; extensionNonce: string; programNonce: string; browser: string; extensionVersion: string }
  | { name: 'ready'; client: Client };

function readAccount(value: unknown): Account | null {
  const orgId = (value as { orgId?: unknown } | null)?.orgId;
  return typeof orgId === 'string' ? { orgId } : null;
}

export class Hub extends EventEmitter<HubEvents> {
  readonly port: number;
  #server: WebSocketServer;
  #token: string;
  #timeout: number;
  #handshakeTimeout: number;
  #clients = new Map<string, Client>();
  #pending = new Map<string, Pending>();
  #preferred: string | null = null;

  private constructor(server: WebSocketServer, options: HubOptions) {
    super();
    this.#server = server;
    this.#token = options.token;
    this.#timeout = options.requestTimeout ?? 60_000;
    this.#handshakeTimeout = options.handshakeTimeout ?? HANDSHAKE_TIMEOUT;
    this.port = (server.address() as AddressInfo).port;
    server.on('connection', (ws, req) => this.#accept(ws, req.headers.origin ?? ''));
  }

  static start(options: HubOptions): Promise<Hub> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        host: options.host ?? '127.0.0.1',
        port: options.port,
        maxPayload: 200 * 1024 * 1024,
        verifyClient: (info, done) => {
          const ok = EXTENSION_ORIGIN.test(info.origin ?? '');
          if (!ok) hub?.emit('rejected', { kind: 'origin', origin: info.origin || '(none)' });
          done(ok, 403);
        }
      });
      let hub: Hub | undefined;
      server.once('error', reject);
      server.once('listening', () => {
        server.off('error', reject);
        hub = new Hub(server, options);
        resolve(hub);
      });
    });
  }

  browsers(): BrowserInfo[] {
    return [...this.#clients.values()].map(c => c.info);
  }

  // the chosen browser if still there, else the newest one that's logged in, else the newest
  active(): BrowserInfo | undefined {
    const preferred = this.#preferred ? this.#clients.get(this.#preferred) : undefined;
    if (preferred) return preferred.info;
    const newest = this.browsers().sort((a, b) => b.connectedAt - a.connectedAt);
    return newest.find(b => b.account) ?? newest[0];
  }

  use(id: string): boolean {
    if (!this.#clients.has(id)) return false;
    this.#preferred = id;
    return true;
  }

  request(operation: Operation): Promise<RequestResult> {
    const target = this.active();
    const client = target && this.#clients.get(target.id);
    if (!client) {
      return Promise.reject(new HubError('no_browser', 'no browser connected: is the extension installed and paired?'));
    }

    const id = randomBytes(6).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HubError('timeout', 'timed out waiting for the browser'));
      }, this.#timeout);
      this.#pending.set(id, { clientId: client.info.id, resolve, reject, timer });
      this.#send(client.ws, { type: 'request', id, ...operation });
    });
  }

  close(): Promise<void> {
    for (const { ws } of this.#clients.values()) ws.close(CloseCode.Shutdown, 'program quit');
    return new Promise(resolve => this.#server.close(() => resolve()));
  }

  #send(ws: WebSocket, message: CompanionMessage): void {
    ws.send(JSON.stringify(message));
  }

  #accept(ws: WebSocket, origin: string): void {
    let stage: Stage = { name: 'hello' };
    // proofs are async: handle one message at a time, in order
    let queue = Promise.resolve();
    const timer = setTimeout(() => ws.close(CloseCode.BadToken, 'handshake timeout'), this.#handshakeTimeout);

    const handle = async (raw: string): Promise<void> => {
      const msg = parseMessage(raw);
      if (!msg) return ws.close(CloseCode.BadMessage, 'bad message');

      if (stage.name === 'hello') {
        if (msg.type !== 'hello') return ws.close(CloseCode.BadMessage, 'expected hello');
        const hello = msg as unknown as HelloMessage;
        const browser = String(hello.browser ?? 'a browser');

        // version before anything else, so an old extension still learns which side to update
        if (hello.protocol !== PROTOCOL_VERSION) {
          const theirs = Number(hello.protocol) || 0;
          this.emit('rejected', { kind: 'protocol', origin, browser, theirs, ours: PROTOCOL_VERSION });
          return ws.close(CloseCode.ProtocolMismatch, mismatchReason(PROTOCOL_VERSION));
        }
        if (!isNonce(hello.nonce)) return ws.close(CloseCode.BadMessage, 'bad nonce');

        const programNonce = createNonce();
        const proof = await makeProof(this.#token, 'program', hello.nonce, programNonce);
        stage = {
          name: 'proof',
          extensionNonce: hello.nonce,
          programNonce,
          browser,
          extensionVersion: String(hello.extensionVersion ?? '?')
        };
        return this.#send(ws, { type: 'challenge', nonce: programNonce, proof });
      }

      if (stage.name === 'proof') {
        const valid =
          msg.type === 'proof' &&
          (await verifyProof(this.#token, 'extension', stage.extensionNonce, stage.programNonce, msg.proof));
        if (!valid) {
          this.emit('rejected', { kind: 'token', origin, browser: stage.browser });
          return ws.close(CloseCode.BadToken, 'bad proof');
        }

        clearTimeout(timer);
        const client: Client = {
          ws,
          info: {
            id: randomBytes(4).toString('hex'),
            browser: stage.browser,
            origin,
            extensionVersion: stage.extensionVersion,
            account: readAccount(msg.account),
            connectedAt: Date.now()
          }
        };
        stage = { name: 'ready', client };
        this.#clients.set(client.info.id, client);
        this.#send(ws, { type: 'welcome', clientId: client.info.id });
        this.emit('connected', client.info);
        return;
      }

      const { client } = stage;
      if (msg.type === 'account') {
        client.info.account = readAccount(msg.account);
        this.emit('account', client.info);
      } else if (msg.type === 'response') {
        this.#settle(msg as unknown as ResponseMessage);
      }
    };

    ws.on('message', raw => {
      queue = queue.then(() => handle(String(raw))).catch(() => ws.close(CloseCode.BadMessage, 'bad message'));
    });

    ws.on('close', code => {
      clearTimeout(timer);
      // the extension checked our proof and it didn't match: the two sides hold different tokens
      if (stage.name === 'proof' && code === CloseCode.ProgramUnverified) {
        this.emit('rejected', { kind: 'token', origin, browser: stage.browser });
      }
      if (stage.name !== 'ready') return;

      const { client } = stage;
      this.#clients.delete(client.info.id);
      for (const [id, p] of this.#pending) {
        if (p.clientId !== client.info.id) continue;
        clearTimeout(p.timer);
        this.#pending.delete(id);
        p.reject(new HubError('disconnected', 'the browser disconnected'));
      }
      this.emit('disconnected', client.info);
    });
  }

  #settle(msg: ResponseMessage): void {
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    clearTimeout(p.timer);

    const client = this.#clients.get(p.clientId);
    if (!client) return p.reject(new HubError('disconnected', 'the browser disconnected'));
    if (msg.ok) p.resolve({ via: msg.via, result: msg.result, browser: client.info });
    else p.reject(new HubError(msg.code, msg.error));
  }
}
