import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import {
  CloseCode,
  PROTOCOL_VERSION,
  createNonce,
  makeProof,
  parseMismatchReason,
  verifyProof,
  type Account
} from '@claude-exporter/protocol';
import { Hub, HubError, type Rejection } from '../src/hub.ts';

const TOKEN = 'a'.repeat(32);
const hub = await Hub.start({ token: TOKEN, port: 0, requestTimeout: 1_000, handshakeTimeout: 300 });
after(() => hub.close());

const EXT = 'chrome-extension://abcdef';

interface FakeBrowser {
  ws: WebSocket;
  clientId: string;
  answer(handler: (req: Record<string, unknown>) => Record<string, unknown> | null): void;
}

function open(origin: string | null): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${hub.port}`, origin ? { origin } : {});
}

function next(ws: WebSocket): Promise<Record<string, unknown>> {
  return once(ws, 'message').then(([raw]) => JSON.parse(String(raw)));
}

const hello = (nonce: string, extra: Record<string, unknown> = {}) => ({
  type: 'hello',
  protocol: PROTOCOL_VERSION,
  nonce,
  browser: 'test',
  extensionVersion: '0.2.0',
  ...extra
});

interface AttemptOptions {
  token?: string;
  nonce?: string;
  hello?: Record<string, unknown>;
  // replaces our real proof: for impostor tests
  proof?: (challenge: Record<string, unknown>, nonce: string) => Promise<unknown> | unknown;
  sendProof?: boolean;
}

// runs the handshake like the extension does; resolves with how it ended up
function attempt(origin: string | null, options: AttemptOptions = {}): Promise<string> {
  const { token = TOKEN, sendProof = true } = options;
  return new Promise(resolve => {
    const nonce = options.nonce ?? createNonce();
    const ws = open(origin);
    ws.on('unexpected-response', (_req, res) => resolve(`HTTP ${res.statusCode}`));
    ws.on('open', () => ws.send(JSON.stringify(options.hello ?? hello(nonce))));
    ws.on('message', async raw => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'challenge' && sendProof) {
        const proof = options.proof
          ? await options.proof(msg, nonce)
          : await makeProof(token, 'extension', nonce, msg.nonce);
        ws.send(JSON.stringify({ type: 'proof', proof, account: null }));
      }
      if (msg.type === 'welcome') {
        resolve('welcome');
        ws.close();
      }
    });
    ws.on('close', code => resolve(`closed ${code}`));
    ws.on('error', () => {});
  });
}

async function connect(browser: string, account: Account | null = { orgId: 'org-1' }): Promise<FakeBrowser> {
  const ws = open(EXT);
  await once(ws, 'open');
  const nonce = createNonce();
  ws.send(JSON.stringify(hello(nonce, { browser })));
  const challenge = await next(ws);
  assert.ok(await verifyProof(TOKEN, 'program', nonce, challenge.nonce as string, challenge.proof));
  const proof = await makeProof(TOKEN, 'extension', nonce, challenge.nonce as string);
  ws.send(JSON.stringify({ type: 'proof', proof, account }));
  const welcome = await next(ws);
  return {
    ws,
    clientId: welcome.clientId as string,
    answer(handler) {
      ws.on('message', data => {
        const req = JSON.parse(String(data));
        if (req.type !== 'request') return;
        const reply = handler(req);
        if (reply) ws.send(JSON.stringify({ type: 'response', id: req.id, ...reply }));
      });
    }
  };
}

// waits for the hub to see the disconnect, not a fixed delay: under load that takes longer
async function untilHub(check: () => boolean, timeout = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('hub never caught up');
    await new Promise(r => setTimeout(r, 10));
  }
}

async function closeAll(...browsers: FakeBrowser[]): Promise<void> {
  for (const b of browsers) {
    b.ws.close();
    await once(b.ws, 'close');
  }
  const ids = new Set(browsers.map(b => b.clientId));
  await untilHub(() => !hub.browsers().some(info => ids.has(info.id)));
}

test('refuses web pages, local scripts, wrong tokens, old extensions and malformed hellos', async () => {
  assert.equal(await attempt('https://evil.example'), 'HTTP 403');
  assert.equal(await attempt(null), 'HTTP 403');
  assert.equal(await attempt(EXT, { token: 'b'.repeat(32) }), `closed ${CloseCode.BadToken}`);
  assert.equal(
    await attempt(EXT, { hello: { type: 'hello', protocol: 1, token: TOKEN, browser: 'old' } }),
    `closed ${CloseCode.ProtocolMismatch}`
  );
  assert.equal(await attempt(EXT, { hello: hello('not-a-nonce') }), `closed ${CloseCode.BadMessage}`);
  assert.equal(await attempt(EXT), 'welcome');
});

test('the program proves itself first, and the token never crosses the wire', async () => {
  const ws = open(EXT);
  const received: string[] = [];
  ws.on('message', raw => received.push(String(raw)));
  await once(ws, 'open');
  const nonce = createNonce();
  ws.send(JSON.stringify(hello(nonce)));
  const challenge = await next(ws);

  assert.equal(challenge.type, 'challenge');
  assert.ok(await verifyProof(TOKEN, 'program', nonce, challenge.nonce as string, challenge.proof));
  assert.ok(!(await verifyProof('b'.repeat(32), 'program', nonce, challenge.nonce as string, challenge.proof)));
  assert.ok(received.every(m => !m.includes(TOKEN)));
  ws.close();
});

test('reflection: sending the program its own proof back gets nothing', async () => {
  const result = await attempt(EXT, { proof: challenge => challenge.proof });
  assert.equal(result, `closed ${CloseCode.BadToken}`);
});

test('replay: resending a recorded hello and proof gets nothing, because the program never repeats its nonce', async () => {
  // what an eavesdropper could capture from a real extension's connection
  const nonce = createNonce();
  let recorded: unknown;
  assert.equal(
    await attempt(EXT, {
      nonce,
      proof: async challenge => (recorded = await makeProof(TOKEN, 'extension', nonce, challenge.nonce as string))
    }),
    'welcome'
  );
  // same extension nonce, same proof: only a fresh program nonce makes this fail
  assert.equal(await attempt(EXT, { nonce, proof: () => recorded }), `closed ${CloseCode.BadToken}`);
});

test('a half-finished handshake times out and is never offered requests', async () => {
  const ws = open(EXT);
  await once(ws, 'open');
  ws.send(JSON.stringify(hello(createNonce())));
  await next(ws);
  assert.equal(hub.browsers().length, 0);
  await assert.rejects(hub.request({ op: 'list', offset: 0, limit: 1 }), (err: HubError) => err.code === 'no_browser');
  const [code] = await once(ws, 'close');
  assert.equal(code, CloseCode.BadToken);
});

test('refusals are reported with a reason, and the close tells the extension our protocol', async () => {
  const seen: Rejection[] = [];
  const listener = (r: Rejection) => seen.push(r);
  hub.on('rejected', listener);

  await attempt('https://evil.example');
  await attempt('moz-extension://1234', { token: 'b'.repeat(32), hello: hello(createNonce(), { browser: 'firefox' }) });

  // the extension's side of a token mismatch: it can't verify us, and says so on closing
  const ws = open('moz-extension://1234');
  await once(ws, 'open');
  ws.send(JSON.stringify(hello(createNonce(), { browser: 'firefox' })));
  await next(ws);
  ws.close(CloseCode.ProgramUnverified, 'program not verified');
  await once(ws, 'close');

  const reason = await new Promise<string>(resolve => {
    const old = open('moz-extension://1234');
    old.on('open', () => old.send(JSON.stringify(hello(createNonce(), { protocol: 7, browser: 'firefox' }))));
    old.on('close', (_code, why) => resolve(String(why)));
  });
  await untilHub(() => seen.length === 4);
  hub.off('rejected', listener);

  assert.deepEqual(seen, [
    { kind: 'origin', origin: 'https://evil.example' },
    { kind: 'token', origin: 'moz-extension://1234', browser: 'firefox' },
    { kind: 'token', origin: 'moz-extension://1234', browser: 'firefox' },
    { kind: 'protocol', origin: 'moz-extension://1234', browser: 'firefox', theirs: 7, ours: PROTOCOL_VERSION }
  ]);
  assert.equal(parseMismatchReason(reason), PROTOCOL_VERSION);
});

test('two browsers stay connected side by side', async () => {
  const chrome = await connect('chrome');
  const firefox = await connect('firefox');
  await new Promise(r => setTimeout(r, 50));

  assert.equal(chrome.ws.readyState, WebSocket.OPEN);
  assert.equal(firefox.ws.readyState, WebSocket.OPEN);
  assert.deepEqual(hub.browsers().map(b => b.browser).sort(), ['chrome', 'firefox']);
  await closeAll(chrome, firefox);
});

test('requests go to the newest logged-in browser, or the one picked with use()', async () => {
  const chrome = await connect('chrome');
  const firefox = await connect('firefox');
  const loggedOut = await connect('logged-out', null);
  for (const b of [chrome, firefox, loggedOut]) b.answer(() => ({ ok: true, via: 'background', result: b.clientId }));

  assert.equal((await hub.request({ op: 'list', offset: 0, limit: 1 })).result, firefox.clientId);
  assert.ok(hub.use(chrome.clientId));
  assert.equal((await hub.request({ op: 'list', offset: 0, limit: 1 })).result, chrome.clientId);

  await closeAll(chrome);
  assert.equal((await hub.request({ op: 'list', offset: 0, limit: 1 })).result, firefox.clientId);
  await closeAll(firefox, loggedOut);
});

test('browser errors arrive with their code', async () => {
  const b = await connect('chrome');
  b.answer(() => ({ ok: false, code: 'not_logged_in', error: 'not logged in' }));
  await assert.rejects(hub.request({ op: 'list', offset: 0, limit: 1 }), (err: HubError) => err.code === 'not_logged_in');
  await closeAll(b);
});

test('a browser that leaves mid-request fails it at once instead of timing out', async () => {
  const b = await connect('chrome');
  b.answer(() => {
    b.ws.close();
    return null;
  });
  const started = Date.now();
  await assert.rejects(hub.request({ op: 'list', offset: 0, limit: 1 }), (err: HubError) => err.code === 'disconnected');
  assert.ok(Date.now() - started < 500);
});

test('a browser that never answers times out', async () => {
  const b = await connect('chrome');
  await assert.rejects(hub.request({ op: 'list', offset: 0, limit: 1 }), (err: HubError) => err.code === 'timeout');
  await closeAll(b);
});

test('with no browser, requests fail with a clear message', async () => {
  await untilHub(() => hub.browsers().length === 0);
  await assert.rejects(hub.request({ op: 'list', offset: 0, limit: 1 }), (err: HubError) => err.code === 'no_browser');
});

test('account changes are tracked per browser', async () => {
  const b = await connect('chrome');
  assert.deepEqual(hub.browsers().find(i => i.id === b.clientId)?.account, { orgId: 'org-1' });
  const changed = once(hub, 'account');
  b.ws.send(JSON.stringify({ type: 'account', account: null }));
  const [info] = await changed;
  assert.equal(info.account, null);
  await closeAll(b);
});
