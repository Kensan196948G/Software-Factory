import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// 既存の必須quality jobが実行するunit suiteへ接続する。workflow変更不要。
// 全て一時ディレクトリ・偽gh。実サービス・実DB・実GitHubへは接続しない。
it('PR マージ前ゲートの隔離shell回帰が全て成功する', () => {
  const output = execFileSync('bash', [resolve('scripts/ops/tests/pr-ready.test.sh')], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(output).toContain('/ FAIL 0 ==');
  expect(output).toContain('PASS: PR-linked な run が必要と案内する');
  expect(output).toContain('PASS: 書き込み系の gh 呼び出しは 0 件');
  expect(output).toContain('PASS: workflow run（再実行）は 0 件');
}, 130_000);
