import { parseArgs } from 'node:util';
import { DEFAULT_PORT } from '@claude-exporter/protocol';
import { defaultOutDir, loadToken } from './config.ts';
import { Hub } from './hub.ts';

export interface AppContext {
  hub: Hub;
  token: string;
  port: number;
  outDir: string;
}

// shared startup for the TUI and the line-mode REPL
export async function startApp(argv = process.argv.slice(2)): Promise<AppContext> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      out: { type: 'string' }
    }
  });

  const port = Number(values.port ?? process.env.CLAUDE_EXPORTER_PORT ?? DEFAULT_PORT);
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
