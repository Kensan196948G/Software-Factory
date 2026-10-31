/**
 * README用のデモGIF素材（PNGフレーム）を撮影する。
 * 使い方: node scripts/capture-demo.mjs [outDir]（要: APIサーバ起動）
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:8781';
const outDir = resolve(process.argv[2] ?? '/tmp/msf-demo');
const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const password = process.env.SEED_ADMIN_PASSWORD ?? '';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const login = await page.request.post(`${base}/api/auth/login`, { data: { email, password } });
if (!login.ok()) throw new Error(`login failed: ${login.status()}`);
await page.goto(base);
await page.waitForSelector('button[data-v="home"]');
await page.waitForTimeout(800);

const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(outDir, name) });
  console.log('captured', name);
};

await shot('01-home.png');
await page.click('button[data-v="board"]');
await shot('02-board.png');
await page.click('button[data-v="list"]');
await shot('03-list.png');
await page.click('button[data-v="new"]');
await shot('04-new.png');
await page.click('button[data-v="data"]');
await shot('05-data.png');

await browser.close();
console.log(`frames -> ${outDir}`);
