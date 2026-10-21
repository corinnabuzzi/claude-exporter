// Zips dist/chrome and dist/firefox for the stores, plus the source archive
// addons.mozilla.org asks for when code is bundled.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const release = new URL('release/', root);
await rm(release, { recursive: true, force: true });
await mkdir(release, { recursive: true });

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'pipe' }).toString();

for (const browser of ['chrome', 'firefox']) {
  const name = `claude-exporter-${browser}-${version}.zip`;
  run('npx', ['web-ext', 'build', '--source-dir', `dist/${browser}`, '--artifacts-dir', 'release', '--filename', name]);
  console.log(`✓ release/${name}`);
}

// git archive only includes committed files: the gitignored private fixtures can't leak into it.
// It archives the current directory, so run it from the repo root.
const repo = run('git', ['rev-parse', '--show-toplevel']).trim();
const dirty = run('git', ['status', '--porcelain']).trim();
if (dirty) {
  console.warn('! uncommitted changes: the source archive is built from the last commit, not from your working tree');
}
const source = `claude-exporter-source-${version}.zip`;
execFileSync('git', ['archive', '--format=zip', '-o', new URL(source, release).pathname, 'HEAD'], { cwd: repo });
console.log(`✓ release/${source} (for the Firefox reviewers)`);
