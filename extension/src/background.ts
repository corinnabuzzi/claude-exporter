import {
  CloseCode,
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  UUID_RE,
  parseMessage,
  parseMismatchReason,
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

export type State = 'idle' | 'connecting' | 'connected' | 'offline' | 'rejected' | 'outdated';

class ApiError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

let ws: WebSocket | null = null;
let starting = false;
let state: State = 'idle';
let detail = '';
let account: Account | null = null;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 1_000;

function setState(next: State, info = ''): void {
  state = next;
  detail = info;
  const badges: Partial<Record<State, [string, string]>> = {
    connected: ['✓', '#2e7d32'],
    rejected: ['!', '#c62828'],
    outdated: ['!', '#c62828']
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
  const [session, org] = await Promise.all([
    chrome.cookies.get({ url: BASE, name: 'sessionKey' }),
    chrome.cookies.get({ url: BASE, name: 'lastActiveOrg' })
  ]);
  if (!session || !org?.value || !UUID_RE.test(org.value)) return null;
  return { orgId: org.value };
}

async function connect(): Promise<void> {
  if (starting || ws) return;
  starting = true;
  clearTimeout(retryTimer);

  try {
    const stored = await chrome.storage.local.get(['port', 'token']);
    const port = typeof stored.port === 'number' ? stored.port : DEFAULT_PORT;
    const token = typeof stored.token === 'string' ? stored.token : '';
    if (!token) return setState('idle', 'no pairing token yet');

    account = await readAccount();
    setState('connecting');

    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    ws = sock;
    sock.onopen = () =>
      send(sock, {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        token,
        browser: BROWSER,
        extensionVersion: chrome.runtime.getManifest().version,
        account
      });
    sock.onmessage = e => void onMessage(sock, String(e.data));
    sock.onclose = e => onClose(sock, e.code, e.reason);
  } finally {
    starting = false;
  }
}

function onClose(sock: WebSocket, code: number, reason: string): void {
  if (ws !== sock) return;
  ws = null;
  clearInterval(pingTimer);

  if (code === CloseCode.BadToken) {
    return setState('rejected', 'the token doesn\'t match: copy it again from the program');
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
  if (ws) {
    const old = ws;
    ws = null;
    old.close(1000, 'reconnecting');
  }
  void connect();
}

async function onMessage(sock: WebSocket, raw: string): Promise<void> {
  const msg = parseMessage(raw);
  if (!msg) return;

  if (msg.type === 'welcome') {
    retryDelay = 1_000;
    setState('connected');
    // traffic on the socket keeps the Chrome service worker alive
    pingTimer = setInterval(() => send(sock, { type: 'ping' }), PING_INTERVAL);
    return;
  }

  if (msg.type === 'request' && typeof msg.id === 'string') {
    const id = msg.id;
    try {
      const { via, result } = await perform(msg as unknown as Operation);
      send(sock, { type: 'response', id, ok: true, via, result });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unreachable';
      send(sock, { type: 'response', id, ok: false, code, error: (err as Error).message });
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
  if (next?.orgId === account?.orgId) return;
  account = next;
  if (ws && state === 'connected') send(ws, { type: 'account', account });
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
    if (!ws) {
      retryDelay = 1_000;
      void connect();
    }
    reply({ ok: true });
  }
  return false;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'reconnect' && state !== 'rejected' && state !== 'outdated') void connect();
});

void chrome.alarms.get('reconnect').then(existing => {
  if (!existing) void chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
void connect();
