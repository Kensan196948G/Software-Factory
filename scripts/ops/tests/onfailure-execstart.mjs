#!/usr/bin/env node
/**
 * deploy/systemd/mirai-sf-onfailure.body.sh（正本）から、mirai-sf-onfailure@.service の
 * ExecStart 行を作る。
 *
 *   node scripts/ops/tests/onfailure-execstart.mjs            → 期待する ExecStart 行を出力
 *   node scripts/ops/tests/onfailure-execstart.mjs --body     → /bin/sh に渡る本文（エスケープ前）を出力
 *
 * 規則: `#` で始まる行と空行を除き、各行を空白 1 つで連結する。systemd の引用規則で
 * `\` → `\\`、`"` → `\"`、`$` → `$$`、`%` → `%%` とし、全体を二重引用符で囲む。
 * unit 名は本文に埋め込まず、`%i` を /bin/sh の位置引数 $1 として別に渡す（引用の崩れ・注入を防ぐ）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = readFileSync(resolve(root, 'deploy/systemd/mirai-sf-onfailure.body.sh'), 'utf8');
const body = source
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
  .map((line) => line.trim())
  .join(' ');

if (process.argv[2] === '--body') {
  process.stdout.write(`${body}\n`);
} else {
  const escaped = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$').replace(/%/g, '%%');
  process.stdout.write(`ExecStart=/bin/sh -c "${escaped}" mirai-sf-onfailure %i\n`);
}
