#!/usr/bin/env node
/**
 * 追跡ファイルから秘密情報らしき文字列を検出する（CI用・依存なし）。
 * 検出したら exit 1。値そのものは表示せず、ファイル名と種別だけを出す。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'cloudflare-token', re: /\bCLOUDFLARE_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/ },
  { id: 'db-url-with-password', re: /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]{4,}@/ },
  { id: 'inline-password', re: /\b(?:password|passwd|pwd)\s*[:=]\s*["'][^"'\s]{8,}["']/i },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
];

const ALLOW = [
  /CHANGE_ME/,
  /example\.com/,
  /test-pass/,
  /postgresql:\/\/postgres:postgres@/,
  /SEED_ADMIN_PASSWORD=dummy/,
];

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !/(^|\/)(node_modules|dist|coverage|\.wrangler)\//.test(f))
  .filter((f) => !/\.(png|jpg|jpeg|gif|webp|pdf|zip|woff2?|ttf|ico)$/i.test(f));

let hits = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue;
  for (const rule of PATTERNS) {
    const match = text.match(rule.re);
    if (!match) continue;
    const line = match[0];
    if (ALLOW.some((a) => a.test(line))) continue;
    hits += 1;
    console.error(`NG  ${file}: ${rule.id}`);
  }
}

if (hits > 0) {
  console.error(`秘密情報らしき文字列を ${hits} 件検出しました。リポジトリに入れないでください。`);
  process.exit(1);
}
console.log(`OK  秘密情報スキャン（${files.length} ファイル）`);
