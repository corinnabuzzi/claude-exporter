// Renders icon.svg to the PNG sizes browsers and stores need. Run after editing the SVG:
//   node render-icons.mjs   (needs Playwright's Chromium)
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const SIZES = [16, 32, 48, 128];
const svg = await readFile(new URL('icon.svg', import.meta.url), 'utf8');
const out = new URL('static/icons/', import.meta.url);
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
for (const size of SIZES) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
  );
  await page.screenshot({ path: new URL(`icon-${size}.png`, out).pathname, omitBackground: true });
  await page.close();
  console.log(`✓ static/icons/icon-${size}.png`);
}
await browser.close();
