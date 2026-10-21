// Line-mode interface: handy for scripting and debugging. The TUI is the main one.
import readline from 'node:readline';
import type { ConversationSummary } from '@claude-exporter/core';
import { startApp } from './app.ts';
import { createBackend } from './backend.ts';
import { shortDate, truncate } from './format.ts';
import type { BrowserInfo } from './hub.ts';

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const { hub, token, port, outDir } = await startApp();
const backend = createBackend(hub, { token, outDir });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
let lastList: ConversationSummary[] = [];

function log(line = ''): void {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  console.log(line);
  rl.prompt(true);
}

const describe = (b: BrowserInfo) => `${b.browser} [${b.id}]${b.account ? '' : ' (not logged in)'}`;

hub.on('connected', b => log(`+ browser connected: ${describe(b)}`));
hub.on('disconnected', b => log(`- browser disconnected: ${describe(b)}`));
hub.on('account', b => log(`~ ${b.browser} [${b.id}] ${b.account ? 'logged in' : 'logged out'}`));
hub.on('rejected', reason => log(`! rejected connection: ${reason}`));

async function cmdList(arg: string | undefined): Promise<void> {
  const max = arg === 'all' ? Infinity : Number(arg) || 20;
  log(`fetching ${max === Infinity ? 'all' : max} conversations…`);
  lastList = await backend.list({ max });

  const width = String(lastList.length).length;
  lastList.forEach((c, i) => {
    const marks = `${c.is_starred ? '★' : ' '}${c.is_archived ? 'a' : ' '}`;
    log(`${String(i + 1).padStart(width)} ${marks} ${truncate(shortDate(c.updated_at), 15)} ${truncate(c.project?.name ?? '', 14)} ${c.name || '(untitled)'}`);
  });
  log(`${lastList.length} conversations · "export <number>" to save one`);
}

function resolveTarget(input: string): string | undefined {
  const index = input.match(/^#?(\d+)$/)?.[1];
  if (index) return lastList[Number(index) - 1]?.uuid;
  return input.match(UUID_IN_TEXT)?.[0];
}

async function cmdExport(input: string | undefined): Promise<void> {
  if (!input) return log('usage: export <number from list | chat URL | id>');
  const id = resolveTarget(input);
  if (!id) return log(lastList.length ? 'no such conversation' : 'not a chat URL or id (run "list" to use numbers)');

  const started = Date.now();
  const written = await backend.exportOne(id);
  const { messageCount, files, artifactUrls, title } = written.result;

  log(`✓ ${title}`);
  log(`  ${messageCount} messages, ${files.length} files, ${artifactUrls.length} linked artifacts · ${Date.now() - started} ms`);
  log(`  → ${written.dir}`);
  for (const file of files) {
    const warn = [file.skippedEdits && `${file.skippedEdits} edits skipped`, file.touchedByShell && 'also changed by shell']
      .filter(Boolean)
      .join(', ');
    if (warn) log(`  ⚠ ${file.outputName}: ${warn}`);
  }
}

function cmdBrowsers(): void {
  const list = backend.browsers();
  if (!list.length) return log('no browser connected');
  const active = backend.active();
  for (const b of list) log(`${b.id === active?.id ? '→' : ' '} ${describe(b)} · extension ${b.extensionVersion}`);
}

function cmdUse(id: string | undefined): void {
  if (!id || !backend.use(id)) return log('usage: use <browser id from "browsers">');
  log(`using ${id}`);
}

const HELP = `commands:
  list [n|all]     recent conversations (default 20)
  export <target>  save one: a number from the list, a chat URL, or an id
  browsers         connected browsers (→ = the one in use)
  use <id>         pick a browser
  quit`;

async function run(line: string): Promise<void> {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(' ') || undefined;
  switch (cmd) {
    case '':
    case undefined:
      return;
    case 'list':
    case 'ls':
      return cmdList(arg);
    case 'export':
    case 'e':
      return cmdExport(arg);
    case 'browsers':
      return cmdBrowsers();
    case 'use':
      return cmdUse(arg);
    case 'help':
    case '?':
      return log(HELP);
    case 'quit':
    case 'exit':
      return shutdown();
    default:
      // a pasted URL on its own means export it
      return UUID_IN_TEXT.test(line) ? cmdExport(line.trim()) : log(`unknown command "${cmd}" · try "help"`);
  }
}

async function shutdown(): Promise<void> {
  await hub.close();
  process.exit(0);
}

console.log('Chat Exporter for Claude (line mode)');
console.log(`listening on ws://127.0.0.1:${port} · exports go to ${outDir}`);
console.log(`pairing token: ${token}`);
console.log('type "help" for commands\n');
rl.prompt();

rl.on('line', line => {
  run(line)
    .catch(err => log(`✗ ${(err as Error).message}`))
    .finally(() => rl.prompt());
});
rl.on('close', () => void shutdown());
