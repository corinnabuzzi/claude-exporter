import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { CloseCode, PROTOCOL_VERSION, parseMismatchReason, type Account } from '@claude-exporter/protocol';
import { Hub, HubError, type Rejection } from '../src/hub.ts';

const TOKEN = 'a'.repeat(32);
const hub = await Hub.start({ token: TOKEN, port: 0, requestTimeout: 1_000 });
after(() => hub.close());

interface FakeBrowser {
  ws: WebSocket;
  clientId: string;
  answer(handler: (req: Record<string, unknown>) => Record<string, unknown> | null): void;
}

function open(origin: string | null): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${hub.port}`, origin ? { origin } : {});
}

// resolves with how the connection ended up: welcomed, HTTP-refused, or closed with a code
function attempt(origin: string | null, hello: Record<string, unknown>): Promise<string> {
  return new Promise(resolve => {
    const ws = open(origin);
    ws.on('unexpected-response', (_req, res) => resolve(`HTTP ${res.statusCode}`));
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('message', raw => {
      if (JSON.parse(String(raw)).type === 'welcome') {
        resolve('welcome');
        ws.close();
      }
    });
    ws.on('close', code => resolve(`closed ${code}`));
    ws.on('error', () => {});
  });
}

const hello = (extra: Record<string, unknown> = {}) => ({
  type: 'hello',
  protocol: PROTOCOL_VERSION,
  token: TOKEN,
  browser: 'test',
  extensionVersion: '0.1.0',
  account: { orgId: 'org-1' },
  ...extra
});

async function connect(browser: string, account: Account | null = { orgId: 'org-1' }): Promise<FakeBrowser> {
  const ws = open('chrome-extension://abcdef');
  await once(ws, 'open');
  ws.send(JSON.stringify(hello({ browser, account })));
  const [raw] = await once(ws, 'message');
  const clientId = JSON.parse(String(raw)).clientId as string;
  return {
    ws,
    clientId,
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

test('refuses web pages, local scripts, wrong tokens and old extensions', async () => {
  assert.equal(await attempt('https://evil.example', hello()), 'HTTP 403');
  assert.equal(await attempt(null, hello()), 'HTTP 403');
  assert.equal(await attempt('moz-extension://1234', hello({ token: 'nope' })), `closed ${CloseCode.BadToken}`);
  assert.equal(await attempt('moz-extension://1234', hello({ token: undefined })), `closed ${CloseCode.BadToken}`);
  assert.equal(await attempt('moz-extension://1234', hello({ protocol: 0 })), `closed ${CloseCode.ProtocolMismatch}`);
  assert.equal(await attempt('moz-extension://1234', hello()), 'welcome');
});

test('refusals are reported with a reason, and the close tells the extension our protocol', async () => {
  const seen: Rejection[] = [];
  const listener = (r: Rejection) => seen.push(r);
  hub.on('rejected', listener);

  await attempt('https://evil.example', hello());
  await attempt('moz-extension://1234', hello({ token: 'nope', browser: 'firefox' }));

  const reason = await new Promise<string>(resolve => {
    const ws = open('moz-extension://1234');
    ws.on('open', () => ws.send(JSON.stringify(hello({ protocol: 7, browser: 'firefox' }))));
    ws.on('close', (_code, why) => resolve(String(why)));
  });
  hub.off('rejected', listener);

  assert.deepEqual(seen, [
    { kind: 'origin', origin: 'https://evil.example' },
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
  const changed = once(hub, 'account');
  b.ws.send(JSON.stringify({ type: 'account', account: null }));
  const [info] = await changed;
  assert.equal(info.account, null);
  await closeAll(b);
});
