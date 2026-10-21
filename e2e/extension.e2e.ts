// Full pipeline: built extension in Chromium ⇄ real CLI, against a fake claude.ai
// that serves a real conversation. Not part of `npm test`: needs Playwright + Chromium.
//   npm run e2e
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page, type Route } from 'playwright';
import { exportConversation, type Conversation } from '@claude-exporter/core';
import { CloseCode, mismatchReason } from '@claude-exporter/protocol';

const root = new URL('../', import.meta.url).pathname;
const fixtures = join(root, 'core/test/fixtures/private');
const EXT = join(root, 'extension/dist/chrome');
const PORT = 47901;
const ORG = '11111111-2222-3333-4444-555555555555';
const { WebSocketServer } = createRequire(join(root, 'companion/package.json'))('ws') as typeof import('ws');
const EXTENSION_VERSION: string = JSON.parse(await readFile(join(root, 'extension/package.json'), 'utf8')).version;

if (!existsSync(join(fixtures, 'imparare-c.json'))) {
  console.log('skipped: private fixtures missing');
  process.exit(0);
}

const conversation: Conversation = JSON.parse(await readFile(join(fixtures, 'imparare-c.json'), 'utf8'));
const summaries = [
  { uuid: conversation.uuid, name: conversation.name, updated_at: '2026-10-21T09:00:00Z', project: { name: 'Programming' } },
  ...Array.from({ length: 4 }, (_, i) => ({ uuid: `00000000-0000-0000-0000-00000000000${i}`, name: `Other chat ${i}` }))
];

const tmp = await mkdtemp(join(tmpdir(), 'claude-exporter-e2e-'));
const out = join(tmp, 'out');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- companion: started more than once, so each run gets its own log
let cli: ChildProcessWithoutNullStreams;
let log = '';

function startCli(): void {
  log = '';
  cli = spawn('node', [join(root, 'companion/src/repl.ts'), '--port', String(PORT), '--out', out], {
    env: { ...process.env, XDG_CONFIG_HOME: join(tmp, 'config') }
  });
  cli.stdout.on('data', d => (log += d));
  cli.stderr.on('data', d => (log += d));
}

async function stopCli(): Promise<void> {
  if (cli.exitCode !== null) return;
  cli.stdin.write('quit\n');
  await new Promise(resolve => cli.once('exit', resolve));
}

async function waitFor(pattern: RegExp, timeout = 15_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const clean = log.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const match = clean.match(pattern);
    if (match) return match[0];
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${pattern}\n--- log ---\n${log}`);
}

const send = (line: string) => cli.stdin.write(`${line}\n`);

startCli();
const token = (await waitFor(/pairing token: [0-9a-f]{32}/)).split(': ')[1] ?? '';
assert.match(token, /^[0-9a-f]{32}$/);

// ---- browser with the built extension, logged in to a fake claude.ai
const context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});

const listCalls: string[] = [];
let apiCalls = 0;
await context.route('https://claude.ai/**', (route: Route) => {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/api/')) apiCalls++;
  const json = (body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  if (url.pathname === `/api/organizations/${ORG}/chat_conversations_v2`) {
    listCalls.push(url.search);
    // server caps pages at 2, regardless of the limit asked for
    const offset = Number(url.searchParams.get('offset'));
    const data = summaries.slice(offset, offset + 2);
    return json({ data, has_more: offset + data.length < summaries.length });
  }
  if (url.pathname === `/api/organizations/${ORG}/chat_conversations/${conversation.uuid}`) return json(conversation);
  if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
  return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>fake claude</body></html>' });
});

await context.addCookies([
  { name: 'sessionKey', value: 'fake-session', domain: 'claude.ai', path: '/', secure: true, httpOnly: true },
  { name: 'lastActiveOrg', value: ORG, domain: 'claude.ai', path: '/', secure: true }
]);
const page = await context.newPage();
await page.goto('https://claude.ai/new');

const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extensionId = new URL(sw.url()).host;
const setStorage = (values: Record<string, unknown>) =>
  sw.evaluate(v => chrome.storage.local.set(v), values);
await setStorage({ token, port: PORT });

// opens the popup like a click on the icon would, and reads what it says
async function popupSays(): Promise<{ label: string; detail: string; popup: Page }> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await sleep(1_500);
  const label = (await popup.locator('#label').textContent()) ?? '';
  const detail = (await popup.locator('#detail').textContent()) ?? '';
  return { label, detail, popup };
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (err) {
    failures++;
    console.log(`✖ ${name}\n  ${(err as Error).message.split('\n').join('\n  ')}`);
  }
}

await check('extension pairs and reports a logged-in browser', async () => {
  await waitFor(/\+ browser connected: chrome \[[0-9a-f]+\]\n/);
  assert.doesNotMatch(log, /not logged in/);
});

await check('list pages through a server that caps page size', async () => {
  send('list 5');
  await waitFor(/5 conversations ·/);
  assert.match(log, /1 .*Programming.*Imparare C/);
  assert.match(log, /5 .*Other chat 3/);
  assert.equal(listCalls.length, 3);
});

await check('export writes the chat and its files to disk', async () => {
  send('export 1');
  await waitFor(/→ .*imparare_c-4da0e155/);
  const dir = join(out, 'imparare_c-4da0e155');
  assert.deepEqual((await readdir(dir)).sort(), ['conversation.json', 'files', 'imparare_c.md']);

  const expected = exportConversation(conversation, { embedFiles: false, filesDir: 'files' });
  assert.equal(await readFile(join(dir, 'imparare_c.md'), 'utf8'), expected.markdown);
});

await check('the dispensa on disk is byte-identical to the file Claude delivered', async () => {
  const path = join(out, 'imparare_c-4da0e155/files/dispensa_C_capitolo1.html');
  const expectedPath = join(fixtures, 'dispensa_C_capitolo1.expected.html');
  if (!existsSync(expectedPath)) return console.log('  (skipped: expected file missing)');
  assert.ok((await readFile(path)).equals(await readFile(expectedPath)));
});

await check('logging out is noticed, and exports then fail clearly', async () => {
  await context.clearCookies({ name: 'sessionKey' });
  await waitFor(/~ chrome \[[0-9a-f]+\] logged out/);
  send('export 1');
  await waitFor(/✗ not logged in to claude\.ai/);
});

await check('the program sees the browser in "browsers"', async () => {
  send('browsers');
  const line = await waitFor(/→ chrome \[[0-9a-f]+\] \(not logged in\) · extension \S+/);
  assert.ok(line.endsWith(`extension ${EXTENSION_VERSION}`), line);
});

await check('a wrong token: the extension won\'t trust the program, and both sides say why', async () => {
  await setStorage({ token: 'f'.repeat(32) });
  await waitFor(/! rejected: chrome tried to connect with a different pairing token/);
  const { label, detail, popup } = await popupSays();
  await popup.close();
  assert.equal(label, 'Couldn\'t verify the program');
  assert.match(detail, /Copy the token again from the program/);

  await setStorage({ token });
  await waitFor(/\+ browser connected: chrome/);
});

await check('after the program restarts, the extension is back within the 5 s retry cap', async () => {
  await stopCli();
  await sleep(3_000);
  startCli();
  const started = Date.now();
  await waitFor(/\+ browser connected: chrome/, 10_000);
  const took = Date.now() - started;
  assert.ok(took < 7_000, `took ${took} ms`);
  console.log(`  (reconnected in ${(took / 1000).toFixed(1)} s)`);
});

// something else listening on the program's port: an older or newer release, or an impostor.
// Records everything the extension sends it.
async function withFakeProgram(
  onHello: (ws: import('ws').WebSocket) => void,
  fn: (received: string[]) => Promise<void>
): Promise<void> {
  const received: string[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: PORT });
  server.on('connection', ws => {
    ws.on('message', raw => received.push(String(raw)));
    ws.once('message', () => onHello(ws));
  });
  try {
    await fn(received);
  } finally {
    for (const ws of server.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
  }
}

await check('a version mismatch tells the user which side to update', async () => {
  await stopCli();

  await withFakeProgram(
    ws => ws.close(CloseCode.ProtocolMismatch, mismatchReason(0)),
    async () => {
      const { label, detail, popup } = await popupSays();
      await popup.close();
      assert.equal(label, 'Update needed');
      assert.match(detail, /program is older than this extension/);
    }
  );

  await withFakeProgram(
    ws => ws.close(CloseCode.ProtocolMismatch, mismatchReason(99)),
    async () => {
      const { detail, popup } = await popupSays();
      await popup.close();
      assert.match(detail, /extension is older than the program/);
    }
  );

  // a 0.1.x program: it wants the token in the hello, doesn't get it, and refuses
  await withFakeProgram(
    ws => ws.close(CloseCode.BadToken, 'bad token'),
    async () => {
      const { label, detail, popup } = await popupSays();
      await popup.close();
      assert.equal(label, 'Update needed');
      assert.match(detail, /program is older than this extension/);
    }
  );
});

await check('an impostor on the port gets nothing: no token, no proof, no chats', async () => {
  const callsBefore = apiCalls;
  await withFakeProgram(
    ws => {
      // a request straight away, in case the extension answers before checking anything
      ws.send(JSON.stringify({ type: 'request', id: 'early', op: 'list', offset: 0, limit: 10 }));
      // a forged challenge: it can't compute a real proof without the token
      ws.send(JSON.stringify({ type: 'challenge', nonce: 'c'.repeat(64), proof: 'd'.repeat(64) }));
      ws.send(JSON.stringify({ type: 'welcome', clientId: 'fake' }));
      ws.send(JSON.stringify({ type: 'request', id: 'late', op: 'conversation', conversationId: conversation.uuid }));
    },
    async received => {
      const { label, detail, popup } = await popupSays();
      await popup.close();
      assert.equal(label, 'Couldn\'t verify the program');
      assert.match(detail, /another app is using that port/);

      assert.ok(received.length > 0, 'the extension did try to connect');
      assert.deepEqual([...new Set(received.map(r => JSON.parse(r).type))], ['hello']);
      assert.ok(received.every(r => !r.includes(token)), 'the token was sent');
      assert.equal(apiCalls, callsBefore, 'claude.ai was queried for the impostor');
      console.log(`  (${received.length} hello${received.length > 1 ? 's' : ''} sent, nothing else)`);
    }
  );
});

await check('opening the popup reconnects at once, even after a refusal', async () => {
  startCli();
  await waitFor(/listening/);
  const started = Date.now();
  const { popup } = await popupSays();
  await waitFor(/\+ browser connected: chrome/, 5_000);
  await popup.close();
  console.log(`  (connected ${((Date.now() - started) / 1000).toFixed(1)} s after opening the popup)`);
});

await stopCli();
await context.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
