import {
  CloseCode,
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  UUID_RE,
  createNonce,
  isNonce,
  makeProof,
  parseMessage,
  parseMismatchReason,
  verifyProof,
  type Account,
  type ErrorCode,
  type ExtensionMessage,
  type Operation,
  type Via
} from '@claude-exporter/protocol';

const BASE = 'https://claude.ai';
const CONVERSATION_QUERY = 'tree=true&rendering_mode=messages&render_all_tools=true';
const BROWSER = navigator.userAgent.includes('Firefox') ? 'firefox' : 'chrome';
const PING_INTERVAL = 20_000;
const MAX_PAGE = 100;
// while the worker is awake; once the browser suspends it, only the 30 s alarm or the popup wake it
const MAX_RETRY_DELAY = 5_000;

export type State = 'idle' | 'connecting' | 'connected' | 'offline' | 'rejected' | 'outdated' | 'unverified';

// states that need the user to do something: no automatic retries, only the popup or a new token
const STUCK: ReadonlySet<State> = new Set(['rejected', 'outdated', 'unverified']);

class ApiError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// one per connection attempt; nothing is served until the program has proven it holds the token
interface Session {
  sock: WebSocket;
  port: number;
  token: string;
  nonce: string;
  programVerified: boolean;
  programFailed: boolean;
  welcomed: boolean;
  queue: Promise<void>;
}

let session: Session | null = null;
let starting = false;
let state: State = 'idle';
let detail = '';
let pingTimer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 1_000;
let lastAccount: Account | null = null;

function setState(next: State, info = ''): void {
  state = next;
  detail = info;
  const badges: Partial<Record<State, [string, string]>> = {
    connected: ['✓', '#2e7d32'],
    rejected: ['!', '#c62828'],
    outdated: ['!', '#c62828'],
    unverified: ['!', '#c62828']
  };
  const [text, color] = badges[next] ?? ['', '#000000'];
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
}

function send(sock: WebSocket, message: ExtensionMessage): void {
  if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(message));
}

// logged in = a session cookie exists; its value is never read or sent anywhere
async function readAccount(): Promise<Account | null> {
  const [cookie, org] = await Promise.all([
    chrome.cookies.get({ url: BASE, name: 'sessionKey' }),
    chrome.cookies.get({ url: BASE, name: 'lastActiveOrg' })
  ]);
  if (!cookie || !org?.value || !UUID_RE.test(org.value)) return null;
  return { orgId: org.value };
}

async function connect(): Promise<void> {
  if (starting || session) return;
  starting = true;
  clearTimeout(retryTimer);

  try {
    const stored = await chrome.storage.local.get(['port', 'token']);
    const port = typeof stored.port === 'number' ? stored.port : DEFAULT_PORT;
    const token = typeof stored.token === 'string' ? stored.token : '';
    if (!token) return setState('idle', 'no pairing token yet');

    setState('connecting');
    const s: Session = {
      sock: new WebSocket(`ws://127.0.0.1:${port}`),
      port,
      token,
      nonce: createNonce(),
      programVerified: false,
      programFailed: false,
      welcomed: false,
      queue: Promise.resolve()
    };
    session = s;

    // no token here: whatever is listening has to prove it already knows it
    s.sock.onopen = () =>
      send(s.sock, {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        nonce: s.nonce,
        browser: BROWSER,
        extensionVersion: chrome.runtime.getManifest().version
      });
    s.sock.onmessage = e => {
      s.queue = s.queue.then(() => onMessage(s, String(e.data))).catch(() => s.sock.close());
    };
    s.sock.onclose = e => onClose(s, e.code, e.reason);
  } finally {
    starting = false;
  }
}

function onClose(s: Session, code: number, reason: string): void {
  if (session !== s) return;
  session = null;
  clearInterval(pingTimer);

  if (s.programFailed) {
    return setState(
      'unverified',
      `whatever answered on port ${s.port} couldn't prove it has this token. Copy the token again from the program. ` +
        `If the program isn't running, another app is using that port.`
    );
  }
  if (code === CloseCode.BadToken) {
    // a protocol 1 program rejects our token-less hello before proving anything
    return s.programVerified
      ? setState('rejected', 'the token doesn\'t match: copy it again from the program')
      : setState('outdated', 'the program is older than this extension: download the latest program');
  }
  if (code === CloseCode.ProtocolMismatch) {
    const theirs = parseMismatchReason(reason);
    return setState(
      'outdated',
      theirs !== null && theirs < PROTOCOL_VERSION
        ? 'the program is older than this extension: download the latest program'
        : 'this extension is older than the program: update it'
    );
  }
  setState('offline', state === 'connected' ? 'connection lost' : 'program not running');

  // timers die with the service worker; the alarm covers that case
  retryTimer = setTimeout(() => void connect(), retryDelay);
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
}

function reconnect(): void {
  retryDelay = 1_000;
  clearInterval(pingTimer);
  if (session) {
    const old = session;
    session = null;
    old.sock.close(1000, 'reconnecting');
  }
  void connect();
}

async function onMessage(s: Session, raw: string): Promise<void> {
  const msg = parseMessage(raw);
  if (!msg) return;

  if (msg.type === 'challenge') {
    if (s.programVerified || s.programFailed) return;
    const valid =
      isNonce(msg.nonce) && (await verifyProof(s.token, 'program', s.nonce, msg.nonce, msg.proof));
    if (!valid) {
      s.programFailed = true;
      return s.sock.close(CloseCode.ProgramUnverified, 'program not verified');
    }
    s.programVerified = true;
    lastAccount = await readAccount();
    send(s.sock, {
      type: 'proof',
      proof: await makeProof(s.token, 'extension', s.nonce, msg.nonce as string),
      account: lastAccount
    });
    return;
  }

  // everything below needs a program that proved itself and accepted our proof
  if (msg.type === 'welcome') {
    if (!s.programVerified) return;
    s.welcomed = true;
    retryDelay = 1_000;
    setState('connected');
    // traffic on the socket keeps the Chrome service worker alive
    pingTimer = setInterval(() => send(s.sock, { type: 'ping' }), PING_INTERVAL);
    return;
  }

  if (msg.type === 'request' && s.welcomed && typeof msg.id === 'string') {
    const id = msg.id;
    try {
      const { via, result } = await perform(msg as unknown as Operation);
      send(s.sock, { type: 'response', id, ok: true, via, result });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unreachable';
      send(s.sock, { type: 'response', id, ok: false, code, error: (err as Error).message });
    }
  }
}

// only these two reads are possible: even a compromised program can't make the extension delete or post anything
async function perform(operation: Operation): Promise<{ via: Via; result: unknown }> {
  const current = await readAccount();
  if (!current) throw new ApiError('not_logged_in', 'not logged in to claude.ai in this browser');
  const org = current.orgId;

  switch (operation.op) {
    case 'list': {
      const { offset, limit } = operation;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
        throw new ApiError('bad_request', 'invalid offset or limit');
      }
      return apiGet(`/api/organizations/${org}/chat_conversations_v2?limit=${limit}&offset=${offset}`);
    }
    case 'conversation': {
      if (!UUID_RE.test(operation.conversationId)) throw new ApiError('bad_request', 'invalid conversation id');
      return apiGet(`/api/organizations/${org}/chat_conversations/${operation.conversationId}?${CONVERSATION_QUERY}`);
    }
    default:
      throw new ApiError('bad_request', 'unknown operation');
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new ApiError('http', `HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) throw new ApiError('http', `expected JSON, got ${type || 'no content type'}`);
  return res.json();
}

async function apiGet(path: string): Promise<{ via: Via; result: unknown }> {
  let backgroundError: string;
  try {
    return { via: 'background', result: await getJson(BASE + path) };
  } catch (err) {
    backgroundError = (err as Error).message;
  }

  try {
    return { via: 'tab', result: await getInTab(path) };
  } catch (err) {
    throw new ApiError('http', `background: ${backgroundError} | tab: ${(err as Error).message}`);
  }
}

async function getInTab(path: string): Promise<unknown> {
  const tabs = await chrome.tabs.query({ url: `${BASE}/*` });
  const tab = tabs.find(t => !t.discarded) ?? tabs[0];
  if (tab?.id === undefined) throw new Error('no claude.ai tab open');

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: pageGet,
    args: [path]
  });

  const result = injection?.result as { data?: unknown; error?: string } | undefined;
  if (!result) throw new Error('page script returned nothing');
  if (result.error) throw new Error(result.error);
  return result.data;
}

// injected into the claude.ai page: must not reference anything outside itself
async function pageGet(path: string): Promise<{ data?: unknown; error?: string }> {
  try {
    const res = await fetch(path, { credentials: 'include' });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function refreshAccount(): Promise<void> {
  const next = await readAccount();
  if (next?.orgId === lastAccount?.orgId) return;
  lastAccount = next;
  if (session?.welcomed) send(session.sock, { type: 'account', account: next });
}

chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (cookie.domain.endsWith('claude.ai') && (cookie.name === 'sessionKey' || cookie.name === 'lastActiveOrg')) {
    void refreshAccount();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.token || changes.port)) reconnect();
});

chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, reply) => {
  if (msg.type === 'status') {
    void readAccount().then(current => reply({ state, detail, loggedIn: Boolean(current) }));
    return true;
  }
  if (msg.type === 'reconnect') {
    reconnect();
    reply({ ok: true });
  }
  // the popup opening is the user saying "now": skip whatever backoff or alarm is pending
  if (msg.type === 'wake') {
    if (!session) {
      retryDelay = 1_000;
      void connect();
    }
    reply({ ok: true });
  }
  return false;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'reconnect' && !STUCK.has(state)) void connect();
});

void chrome.alarms.get('reconnect').then(existing => {
  if (!existing) void chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
void connect();
