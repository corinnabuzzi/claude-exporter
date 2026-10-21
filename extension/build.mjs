// Builds dist/chrome and dist/firefox from one source and one base manifest.
import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const root = new URL('./', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const base = JSON.parse(await readFile(new URL('static/manifest.json', root), 'utf8'));

// permanent once published on addons.mozilla.org: change it before the first upload, never after
export const GECKO_ID = 'claude-exporter@corinnabuzzi.dev';

const BROWSERS = {
  chrome: {
    background: { service_worker: 'background.js' },
    minimum_chrome_version: '120'
  },
  firefox: {
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      // 140 is the first version that understands data_collection_permissions
      gecko: {
        id: GECKO_ID,
        strict_min_version: '140.0',
        // chats go to a program on the same computer, never to the developer or anyone else
        data_collection_permissions: { required: ['none'] }
      },
      gecko_android: { strict_min_version: '142.0' }
    }
  }
};

const esbuildOptions = {
  entryPoints: ['src/background.ts', 'src/popup.ts'],
  bundle: true,
  format: 'iife',
  target: ['chrome120', 'firefox140'],
  // stores review the code: keep it readable
  minify: false,
  logLevel: 'warning'
};

for (const [browser, extra] of Object.entries(BROWSERS)) {
  const out = new URL(`dist/${browser}/`, root);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(new URL('static/', root), out, { recursive: true });

  const manifest = { ...base, ...extra, version: pkg.version };
  await writeFile(new URL('manifest.json', out), `${JSON.stringify(manifest, null, 2)}\n`);

  const options = { ...esbuildOptions, outdir: `dist/${browser}` };
  if (watch) await (await context(options)).watch();
  else await build(options);
  console.log(`✓ dist/${browser} (${pkg.version})`);
}
