#!/usr/bin/env node
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT, type Operation } from '@claude-exporter/protocol';
import type { Conversation, ConversationSummary } from '@claude-exporter/core';
import { defaultOutDir, loadToken } from './config.ts';
import { Hub, type BrowserInfo } from './hub.ts';
import { listConversations } from './list.ts';
import { writeExport } from './write.ts';

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const { values: args } = parseArgs({
  options: {
    port: { type: 'string' },
    out: { type: 'string' }
  }
});

const port = Number(args.port ?? process.env.CLAUDE_EXPORTER_PORT ?? DEFAULT_PORT);
const outDir = args.out ?? process.env.CLAUDE_EXPORTER_OUT ?? defaultOutDir();
const token = await loadToken();

let hub: Hub;
try {
  hub = await Hub.start({ port, token });
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  console.error(code === 'EADDRINUSE' ? `port ${port} is already in use: is another copy running?` : String(err));
  process.exit(1);
}

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

async function call(operation: Operation): Promise<unknown> {
  const { result } = await hub.request(operation);
  return result;
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const shortDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

async function cmdList(arg: string | undefined): Promise<void> {
  const max = arg === 'all' ? Infinity : Number(arg) || 20;
  log(`fetching ${max === Infinity ? 'all' : max} conversations…`);
  lastList = await listConversations((offset, limit) => call({ op: 'list', offset, limit }), { max });

  const width = String(lastList.length).length;
  lastList.forEach((c, i) => {
    const marks = `${c.is_starred ? '★' : ' '}${c.is_archived ? 'a' : ' '}`;
    log(`${String(i + 1).padStart(width)} ${marks} ${pad(shortDate(c.updated_at), 15)} ${pad(c.project?.name ?? '', 14)} ${c.name || '(untitled)'}`);
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
  const { result, via } = await hub.request({ op: 'conversation', conversationId: id });
  const written = await writeExport(result as Conversation, outDir);
  const { messageCount, files, artifactUrls } = written.result;

  log(`✓ ${written.result.title}`);
  log(`  ${messageCount} messages, ${files.length} files, ${artifactUrls.length} linked artifacts · via ${via}, ${Date.now() - started} ms`);
  log(`  → ${written.dir}`);
  for (const file of files) {
    const warn = [file.skippedEdits && `${file.skippedEdits} edits skipped`, file.touchedByShell && 'also changed by shell']
      .filter(Boolean)
      .join(', ');
    if (warn) log(`  ⚠ ${file.outputName}: ${warn}`);
  }
}

function cmdBrowsers(): void {
  const list = hub.browsers();
  if (!list.length) return log('no browser connected');
  const active = hub.active();
  for (const b of list) log(`${b.id === active?.id ? '→' : ' '} ${describe(b)} · extension ${b.extensionVersion}`);
}

function cmdUse(id: string | undefined): void {
  if (!id || !hub.use(id)) return log('usage: use <browser id from "browsers">');
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

console.log('claude-exporter');
console.log(`listening on ws://127.0.0.1:${hub.port} · exports go to ${outDir}`);
console.log(`pairing token: ${token}`);
console.log('type "help" for commands\n');
rl.prompt();

rl.on('line', line => {
  run(line)
    .catch(err => log(`✗ ${(err as Error).message}`))
    .finally(() => rl.prompt());
});
rl.on('close', () => void shutdown());
