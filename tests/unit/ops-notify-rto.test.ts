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
    const err = String((error as { stderr?: unknown }).stderr ?? '');
    const failed = out.split('\n').filter((line) => line.startsWith('FAIL') || line.startsWith('== 結果'));
    const errTail = err.split('\n').slice(-60).join('\n');
    const outTail = out.split('\n').filter((line) => !line.startsWith('PASS')).slice(-60).join('\n');
    throw new Error(`${script} が失敗しました:\n${failed.join('\n')}\n--- stdout（PASS 以外の末尾）---\n${outTail}\n--- stderr（末尾）---\n${errTail}`);
  }
};

it('失敗通知（OnFailure template）の隔離shell回帰が全て成功する', () => {
  const output = run('onfailure-notify.test.sh');
  expect(output).toContain('/ FAIL 0 ==');
  expect(output).toContain('PASS: unit の ExecStart は正本（body.sh）をエスケープした結果と一致する');
  expect(output).toContain('PASS: 改行入り unit 名は記録しない');
  expect(output).toContain('PASS: notify.env なしで終了コード 0');
  // notify.env の権限・種別・親ディレクトリ（0600 以下・通常ファイル・本人所有・親は group/other 書込みなし）
  expect(output).toContain('PASS: notify.env 644 では送信コマンドを実行しない');
  expect(output).toContain('PASS: notify.env 640 では送信コマンドを実行しない');
  expect(output).toContain('PASS: notify.env 604 では送信コマンドを実行しない');
  expect(output).toContain('PASS: ディレクトリは終了コード 4');
  expect(output).toContain('PASS: symlink では送信コマンドを実行しない');
  expect(output).toContain('PASS: HOME/.config/mirai-sf 775 では送信コマンドを実行しない');
  expect(output).toContain('PASS: HOME/.config/mirai-sf の symlink では送信コマンドを実行しない');
}, 250_000);

it('全体RTO訓練（rto-drill.sh）の隔離shell回帰が全て成功する', () => {
  const output = run('rto-drill.test.sh');
  expect(output).toContain('/ FAIL 0 ==');
  expect(output).toContain('PASS: 拒否: mirai_sf_prod_fake');
  expect(output).toContain('PASS: dry-run は DB を作らない');
  expect(output).toContain('PASS: 失敗しても一時DBを削除');
  // 死んだプロキシ環境でも一時 API を直接確認する（--noproxy）
  expect(output).toContain('PASS: 死んだプロキシがあっても成功（終了コード 0）');
  // /healthz の environment=production 必須と、その診断
  expect(output).toContain('PASS: environment 不一致は終了コード 1');
  expect(output).toContain('PASS: 診断に environment=production の条件を出す');
  // cleanup 失敗（一時DBの残存）は終了コード 2
  expect(output).toContain('PASS: dropdb 失敗は終了コード 2');
}, 250_000);
