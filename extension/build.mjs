import { context, build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const out = new URL('./dist/', import.meta.url);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(new URL('./static/', import.meta.url), out, { recursive: true });

// one version number: package.json wins
const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const manifestUrl = new URL('manifest.json', out);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
manifest.version = pkg.version;
await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);

const options = {
  entryPoints: ['src/background.ts', 'src/popup.ts'],
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: ['chrome120', 'firefox128'],
  logLevel: 'info'
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
