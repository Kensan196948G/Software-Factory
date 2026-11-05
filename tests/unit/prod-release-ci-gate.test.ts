import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// 既存の必須quality jobが実行するunit suiteへ接続する。workflow変更不要。
// 全て一時repo・偽gh・偽pnpm・偽psql。実サービス・実DB・実GitHubへは接続しない。
it('本番releaseのexact-main CIゲートの隔離shell回帰が全て成功する', () => {
  const output = execFileSync('bash', [resolve('scripts/ops/tests/prod-release-ci-gate.test.sh')], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(output).toContain('/ FAIL 0 ==');
  expect(output).toContain('PASS: CI 未完了は終了コード 75');
  expect(output).toContain('PASS: CI 失敗は終了コード 1');
  expect(output).toContain('PASS: 0 を渡しても CI 失敗は終了コード 1');
  expect(output).toContain('PASS: Staging 単独は CI を照会しない');
}, 130_000);
