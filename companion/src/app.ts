import { parseArgs } from 'node:util';
import { DEFAULT_PORT } from '@claude-exporter/protocol';
import { configDir, defaultOutDir, loadToken } from './config.ts';
import { Hub } from './hub.ts';

export interface AppContext {
  hub: Hub;
  token: string;
  port: number;
  outDir: string;
}

// set at build time for compiled binaries
export const VERSION = process.env.CLAUDE_EXPORTER_VERSION ?? 'dev';

const HELP = `Chat Exporter for Claude ${VERSION}
Export your claude.ai chats to Markdown, with the files Claude made.

usage: claude-exporter [options]

options:
  --out <dir>     where exports go (default: ${defaultOutDir()})
  --port <n>      port the browser extension connects to (default: ${DEFAULT_PORT})
  -v, --version   print the version
  -h, --help      show this help

environment:
  CLAUDE_EXPORTER_OUT, CLAUDE_EXPORTER_PORT   same as the options

The pairing token lives in ${configDir()}/token.`;

// shared startup for the TUI and the line-mode REPL
export async function startApp(argv = process.argv.slice(2)): Promise<AppContext> {
  let values: { port?: string; out?: string; version?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        port: { type: 'string' },
        out: { type: 'string' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' }
      }
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (values.version) {
    console.log(VERSION);
    process.exit(0);
  }

  const port = Number(values.port ?? process.env.CLAUDE_EXPORTER_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error(`invalid port: ${values.port ?? process.env.CLAUDE_EXPORTER_PORT}`);
    process.exit(2);
  }
  const outDir = values.out ?? process.env.CLAUDE_EXPORTER_OUT ?? defaultOutDir();
  const token = await loadToken();

  try {
    const hub = await Hub.start({ port, token });
    return { hub, token, port: hub.port, outDir };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(code === 'EADDRINUSE' ? `port ${port} is already in use: is another copy running?` : String(err));
    process.exit(1);
  }
}
