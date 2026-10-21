import { EventEmitter } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CloseCode,
  PROTOCOL_VERSION,
  parseMessage,
  type Account,
  type CompanionMessage,
  type ErrorCode,
  type HelloMessage,
  type Operation,
  type ResponseMessage,
  type Via
} from '@claude-exporter/protocol';

// browsers set Origin themselves, so a web page can't pretend to be an extension
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i;
const HELLO_TIMEOUT = 5_000;

export interface BrowserInfo {
  id: string;
  browser: string;
  origin: string;
  extensionVersion: string;
  account: Account | null;
  connectedAt: number;
}

export interface HubEvents {
  connected: [BrowserInfo];
  disconnected: [BrowserInfo];
  account: [BrowserInfo];
  rejected: [reason: string];
}

export interface HubOptions {
  token: string;
  port: number;
  host?: string;
  requestTimeout?: number;
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

export class Hub extends EventEmitter<HubEvents> {
  readonly port: number;
  #server: WebSocketServer;
  #token: Buffer;
  #timeout: number;
  #clients = new Map<string, Client>();
  #pending = new Map<string, Pending>();
  #preferred: string | null = null;

  private constructor(server: WebSocketServer, options: HubOptions) {
    super();
    this.#server = server;
    this.#token = Buffer.from(options.token);
    this.#timeout = options.requestTimeout ?? 60_000;
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
          if (!ok) hub?.emit('rejected', `origin ${info.origin || '(none)'}`);
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

  #tokenMatches(candidate: unknown): boolean {
    const given = Buffer.from(String(candidate));
    return given.length === this.#token.length && timingSafeEqual(given, this.#token);
  }

  #accept(ws: WebSocket, origin: string): void {
    let client: Client | null = null;
    const helloTimer = setTimeout(() => ws.close(CloseCode.BadToken, 'no hello'), HELLO_TIMEOUT);

    ws.on('message', raw => {
      const msg = parseMessage(String(raw));
      if (!msg) return ws.close(CloseCode.BadMessage, 'bad message');

      if (!client) {
        const hello = msg as unknown as HelloMessage;
        if (msg.type !== 'hello' || !this.#tokenMatches(hello.token)) {
          this.emit('rejected', `${origin}: wrong pairing token`);
          return ws.close(CloseCode.BadToken, 'bad token');
        }
        if (hello.protocol !== PROTOCOL_VERSION) {
          this.emit('rejected', `${origin}: protocol ${hello.protocol}, expected ${PROTOCOL_VERSION}`);
          return ws.close(CloseCode.ProtocolMismatch, 'protocol mismatch');
        }
        clearTimeout(helloTimer);
        client = {
          ws,
          info: {
            id: randomBytes(4).toString('hex'),
            browser: String(hello.browser ?? 'unknown'),
            origin,
            extensionVersion: String(hello.extensionVersion ?? '?'),
            account: hello.account ?? null,
            connectedAt: Date.now()
          }
        };
        this.#clients.set(client.info.id, client);
        this.#send(ws, { type: 'welcome', clientId: client.info.id });
        this.emit('connected', client.info);
        return;
      }

      if (msg.type === 'account') {
        client.info.account = (msg.account as Account | null) ?? null;
        this.emit('account', client.info);
      } else if (msg.type === 'response') {
        this.#settle(msg as unknown as ResponseMessage);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!client) return;
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
