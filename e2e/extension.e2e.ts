// Full pipeline: built extension in Chromium ⇄ real CLI, against a fake claude.ai
// that serves a real conversation. Not part of `npm test`: needs Playwright + Chromium.
//   npm run build -w extension && node e2e/extension.e2e.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Route } from 'playwright';
import { exportConversation, type Conversation } from '@claude-exporter/core';

const root = new URL('../', import.meta.url).pathname;
const fixtures = join(root, 'core/test/fixtures/private');
const EXT = join(root, 'extension/dist');
const PORT = 47901;
const ORG = '11111111-2222-3333-4444-555555555555';

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

// ---- companion
const cli = spawn('node', [join(root, 'companion/src/repl.ts'), '--port', String(PORT), '--out', out], {
  env: { ...process.env, XDG_CONFIG_HOME: join(tmp, 'config') }
});
let log = '';
cli.stdout.on('data', d => (log += d));
cli.stderr.on('data', d => (log += d));

async function waitFor(pattern: RegExp, timeout = 15_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const clean = log.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const match = clean.match(pattern);
    if (match) return match[0];
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${pattern}\n--- log ---\n${log}`);
}

const token = (await waitFor(/pairing token: [0-9a-f]{32}/)).split(': ')[1] ?? '';
assert.match(token, /^[0-9a-f]{32}$/);
const send = (line: string) => cli.stdin.write(`${line}\n`);

// ---- browser with the built extension, logged in to a fake claude.ai
const context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});

const listCalls: string[] = [];
await context.route('https://claude.ai/**', (route: Route) => {
  const url = new URL(route.request().url());
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
await sw.evaluate(([t, p]) => chrome.storage.local.set({ token: t, port: p }), [token, PORT] as const);

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
  await waitFor(/→ chrome \[[0-9a-f]+\] \(not logged in\) · extension 0\.1\.0/);
});

send('quit');
await context.close();
cli.kill();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
