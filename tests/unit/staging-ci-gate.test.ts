import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// 既存の必須quality jobが実行するunit suiteへ接続する。workflow変更不要。
// 全て一時repo・偽gh・偽health。実サービス・実DB・実GitHubへは接続しない。
it('Staging配備ゲートの隔離shell回帰が全て成功する', () => {
  const output = execFileSync('bash', [resolve('scripts/ops/tests/staging-autofollow.test.sh')], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(output).toContain('/ FAIL 0 ==');
  expect(output).toContain('新runのSHA欠落は release.sh を呼ばない');
  expect(output).toContain('controller の HEAD は元のまま');
}, 130_000);
