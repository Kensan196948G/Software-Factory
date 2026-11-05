import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// 既存の必須quality jobが実行するunit suiteへ接続する。workflow変更不要。
// 全て一時HOME・偽pgクライアント・偽wrangler・偽API。実サービス・実DB・R2・systemdへは接続しない。
const run = (script: string) => {
  try {
    return execFileSync('bash', [resolve(`scripts/ops/tests/${script}`)], {
      encoding: 'utf8',
      timeout: 240_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    // 失敗した検査項目（FAIL 行）を CI のログに残す。秘密は扱わない隔離テストなので出力してよい
    const out = String((error as { stdout?: unknown }).stdout ?? '');
    const failed = out.split('\n').filter((line) => line.startsWith('FAIL') || line.startsWith('== 結果'));
    throw new Error(`${script} が失敗しました:\n${failed.join('\n')}`);
  }
};

it('失敗通知（OnFailure template）の隔離shell回帰が全て成功する', () => {
  const output = run('onfailure-notify.test.sh');
  expect(output).toContain('/ FAIL 0 ==');
  expect(output).toContain('PASS: unit の ExecStart は正本（body.sh）をエスケープした結果と一致する');
  expect(output).toContain('PASS: 改行入り unit 名は記録しない');
  expect(output).toContain('PASS: notify.env なしで終了コード 0');
}, 250_000);

it('全体RTO訓練（rto-drill.sh）の隔離shell回帰が全て成功する', () => {
  const output = run('rto-drill.test.sh');
  expect(output).toContain('/ FAIL 0 ==');
  expect(output).toContain('PASS: 拒否: mirai_sf_prod_fake');
  expect(output).toContain('PASS: dry-run は DB を作らない');
  expect(output).toContain('PASS: 失敗しても一時DBを削除');
}, 250_000);
