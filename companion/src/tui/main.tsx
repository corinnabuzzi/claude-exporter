import { render } from 'ink';
import { startApp } from '../app.ts';
import { createBackend } from '../backend.ts';
import { App, type ExitSummary } from './App.tsx';

const { hub, token, outDir } = await startApp();
const backend = createBackend(hub, { token, outDir });

const app = render(<App backend={backend} />, { alternateScreen: true });
const summary = (await app.waitUntilExit()) as ExitSummary | undefined;
await hub.close();

// the alternate screen is gone now, so this stays in the terminal's history
if (summary?.exported.length) {
  console.log(`exported ${summary.exported.length} chat${summary.exported.length > 1 ? 's' : ''}:`);
  for (const dir of summary.exported) console.log(`  ${dir}`);
}
if (summary?.failed) console.log(`${summary.failed} failed`);
process.exit(0);
