/** 設計HTMLの各セクションをスクリーンショット（QA用）。使い方: node scripts/design-shot.mjs [outDir] */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.cwd(), 'docs/design/msf-intake-design.html');
const outDir = resolve(process.argv[2] ?? '/tmp/design-shots');
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(`file://${file}`);
const ids = await page.$$eval('section[id]', (els) => els.map((e) => e.id));
for (const id of ids) {
  const el = await page.$(`#${id}`);
  if (el) await el.screenshot({ path: resolve(outDir, `${id}.png`) });
}
await browser.close();
console.log(`saved ${ids.length} sections -> ${outDir}`);
