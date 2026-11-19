import { expect, test, IS_ISO } from './fixtures/roles';
import { auditLogs, runDbVerify } from './fixtures/station';
import { recordedRequests } from './fixtures/run-state';

/**
 * A12（共通）: すべての操作が監査に残り、ハッシュ連鎖の検証が OK になる。
 * 対象: 層①②③。
 *
 * 層①は DB へ直接 `db:verify` を実行し、監査 action の種類も DB から確かめる。
 * 層②③は DB へ触れないため、API の監査ログ（chain）と、このラウンドで作った依頼の
 * `request.create` / 拒否 / 遷移の記録で確かめる。本番の `ops:db:verify` はラウンド後に別途実行する。
 */
test('A12 すべての操作が監査に残り、ハッシュ連鎖が OK', { tag: ['@iso', '@otp', '@prod-smoke'] }, async ({ admin, db }) => {
  const { items, chain } = await auditLogs(admin.api, 500);
  expect(chain?.ok, '監査ログのハッシュ連鎖が壊れている').toBe(true);
  expect(chain.checked, '監査ログが 1 件も無い').toBeGreaterThan(0);

  const ids = recordedRequests();
  const recent = ids.slice(-20);
  for (const id of recent) {
    const forRequest = items.filter((entry) => entry.targetId === id);
    expect(
      forRequest.some((entry) => entry.action === 'request.create'),
      `依頼 ${id} の受付が監査に残っていない`,
    ).toBe(true);
  }

  // このラウンドで実際に行った操作の種類（作成・状態遷移・拒否）が監査にある。
  expect(
    items.some((entry) => entry.action === 'request.create'),
    'request.create が監査に無い',
  ).toBe(true);
  expect(
    items.some((entry) => entry.action === 'request.transition'),
    'request.transition が監査に無い',
  ).toBe(true);
  expect(
    items.some((entry) => entry.result === 'denied'),
    '拒否（denied）の監査が無い',
  ).toBe(true);

  if (IS_ISO) {
    expect(db, '層①では DB へ接続できる必要がある').not.toBeNull();
    const groups = (await db!.query(
      `select action, result, count(*)::int as n from audit_log group by action, result order by action, result`,
    )) as { action: string; result: string; n: number }[];
    const has = (action: string, result?: string): boolean =>
      groups.some((g) => g.action === action && (result === undefined || g.result === result));
    expect(has('request.create', 'success'), 'request.create が DB の監査に無い').toBe(true);
    expect(has('request.transition', 'success'), 'request.transition が DB の監査に無い').toBe(true);
    expect(has('request.transition_denied', 'denied'), 'request.transition_denied が DB の監査に無い').toBe(true);
    expect(has('approval.self_denied', 'denied'), '自己承認の拒否（approval.self_denied）が DB の監査に無い').toBe(true);

    const missing = [] as string[];
    for (const id of ids) {
      const rows = (await db!.query(`select 1 from audit_log where target_id = $1 and action = 'request.create' limit 1`, [
        id,
      ])) as unknown[];
      if (rows.length === 0) missing.push(id);
    }
    expect(missing, '受付が監査に残っていない依頼がある').toEqual([]);

    const verify = runDbVerify();
    expect(verify.ok, `db:verify が失敗しました:\n${verify.output.slice(-1200)}`).toBe(true);
    expect(verify.output, '監査ログのハッシュ連鎖の OK 行が無い').toMatch(/監査ログのハッシュ連鎖: \d+ 件 OK/);
    expect(verify.output).toContain('verify 成功');
  }
});
