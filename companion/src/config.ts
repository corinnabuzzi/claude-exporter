import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'claude-exporter');
}

export function defaultOutDir(): string {
  return join(homedir(), 'claude-exports');
}

// stable across restarts, so the extension only needs pairing once
export async function loadToken(dir = configDir()): Promise<string> {
  const file = join(dir, 'token');
  try {
    const saved = (await readFile(file, 'utf8')).trim();
    if (saved) return saved;
  } catch {}
  const fresh = randomBytes(16).toString('hex');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, `${fresh}\n`, { mode: 0o600 });
  return fresh;
}
