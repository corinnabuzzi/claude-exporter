// Compiles the TUI into standalone executables (Bun runtime included).
//   bun build.ts                 → this machine's platform
//   bun build.ts --all           → every release target
import { mkdir } from 'node:fs/promises';
import pkg from './package.json' with { type: 'json' };

const TARGETS = ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-x64', 'bun-darwin-arm64', 'bun-windows-x64'] as const;
type Target = (typeof TARGETS)[number];

// Ink imports React DevTools only in DEV mode, but a bundle hoists that import to the top
// and would crash at startup without the package: swap it for an empty module.
const stubDevtools: Bun.BunPlugin = {
  name: 'stub-react-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} };',
      loader: 'js'
    }));
  }
};

function hostTarget(): Target {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return `bun-${os}-${process.arch}` as Target;
}

const targets = process.argv.includes('--all') ? [...TARGETS] : [hostTarget()];
await mkdir('../dist', { recursive: true });

for (const target of targets) {
  const name = `claude-exporter-${target.replace(/^bun-/, '')}${target.includes('windows') ? '.exe' : ''}`;
  const result = await Bun.build({
    entrypoints: ['src/tui/main.tsx'],
    compile: { target, outfile: `../dist/${name}` },
    minify: true,
    define: { 'process.env.CLAUDE_EXPORTER_VERSION': JSON.stringify(pkg.version) },
    plugins: [stubDevtools]
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`✓ dist/${name}`);
}
