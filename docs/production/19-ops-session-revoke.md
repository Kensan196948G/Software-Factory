# セッション失効の運用手順（監査の空白の是正、2026-11-06）

作成: 2026-11-06 JST。対象は Staging（`mirai_sf`）と本番（`mirai_sf_prod`）の PostgreSQL。正本は `scripts/ops/revoke-sessions.ts`（CLI）と `src/api/session-revoke.ts`（コア）。

## 1. 背景と目的

- [`17-staging-access-jwt-rollout-20261106.md`](17-staging-access-jwt-rollout-20261106.md) §3・§5 のとおり、2026-11-06 05:13 の Staging 旧セッション 21 件の削除は DB の直接操作で、`audit_log` に**記録が残っていない**（監査の空白）。
- 本手順は「条件検証 → 削除 → 監査追記」を**単一トランザクション**で行い、削除のたびに `audit_log` へ 1 行残す。監査は追記のみで、ハッシュ連鎖は `appendAuditTx` が維持する。
- 記録する監査行: `action=session.revoke` / `target_type=session` / `result=success` / `role=system`。`diff` は `database`・`cutoff`・`expectCount`・`deleted`・`reason`・`allowActive`・`via` だけで、**セッション ID は記録しない**。

## 2. 前提

- 先にバックアップを取る（[`02-runbook.md`](02-runbook.md) §5）。削除は即時の利用者影響（再ログイン）だけでデータは消えないが、他の運用手順と同じく dump を残す。
- 次を先に決める。
  - DB 名（`--db`）。**接続先と一致しなければ削除しない**。
  - cutoff（`--cutoff`）。「これより前に作られたセッションを無効化する」境界。API 再起動時刻などをタイムゾーン付き ISO 8601 で指定する（例: `2026-11-06T05:10:01+09:00`）。
  - 対象件数（`--expect-count`）。**実際の対象件数と一致しなければ削除しない**。
  - 1 回の上限（`--max-count`、既定 100、最大 1000）と、理由・実行者（`--reason` / `--actor`）。
- 接続は `scripts/ops/with-env.mjs` 経由で設定ファイル（`preview.conf` / `prod.conf`）から読む。値（接続文字列）は表示しない。
- セッションが有効なまま残っていると既定では中止する。意図的に続行するときだけ `--allow-active` を付ける。

## 3. 手順

```bash
cd /mnt/storage/Software-Factory/Software-Factory

# 1. dry-run（既定）。同じ引数で件数を確認する
MIRAI_SF_ENV_FILE="$HOME/.config/mirai-sf/prod.conf" \
  pnpm ops:revoke-sessions \
  --db mirai_sf_prod \
  --cutoff 2026-11-06T05:10:01+09:00 \
  --expect-count 21 \
  --reason "Access JWT 有効化に伴う旧セッション失効" \
  --actor "owner"

# 2. 表示が「対象候補=--expect-count」「有効=0」「cutoff以後=0」「削除=0」であることを確認する
#    （異なれば --expect-count か --cutoff を見直す。dry-run は何も変更しない）

# 3. 実行（--yes を付けたときだけ削除する）
MIRAI_SF_ENV_FILE="$HOME/.config/mirai-sf/prod.conf" \
  pnpm ops:revoke-sessions \
  --db mirai_sf_prod \
  --cutoff 2026-11-06T05:10:01+09:00 \
  --expect-count 21 \
  --reason "Access JWT 有効化に伴う旧セッション失効" \
  --actor "owner" \
  --yes

# 4. 監査のハッシュ連鎖と DB 全体を確認する
pnpm ops:db:verify
```

- 実行すると `削除=N` と `監査に記録しました: id=… hash=…` が表示される。ID・ハッシュは識別子であり秘密ではない。
- `--yes` を付けない限り、またガードが 1 つでも不成立なら、**削除も監査追記もしない**。
- 出力にセッション ID・接続文字列・秘密は含めない（件数と DB 名だけ）。

## 4. ガード（fail-closed）

| #   | ガード                                                | 不成立のとき                          |
| --- | ----------------------------------------------------- | ------------------------------------- |
| 1   | `--db` が正しい形式（英数字と `_`、1〜63 文字）       | `invalid_db_name`                     |
| 2   | `--cutoff` がタイムゾーン付き ISO 8601 で、未来でない | `invalid_cutoff` / `cutoff_in_future` |
| 3   | `--reason` と `--actor` がある（200 / 100 文字以内）  | `reason_required` ほか                |
| 4   | `--expect-count` が 1 以上かつ `--max-count` 以下     | `invalid_expect_count`                |
| 5   | 接続先の `current_database()` が `--db` と完全一致    | `db_name_mismatch`                    |
| 6   | 有効なセッション（`expires_at > now()`）が 0          | `active_sessions`                     |
| 7   | `created_at >= cutoff` のセッションが 0               | `sessions_after_cutoff`               |
| 8   | 対象件数が上限（`--max-count`、最大 1000）以下        | `count_exceeds_max`                   |
| 9   | 対象件数が `--expect-count` と一致                    | `count_mismatch`                      |
| 10  | 実際に削除できた件数が検証結果と一致                  | `delete_count_mismatch`（ROLLBACK）   |

- 検証と削除は同じトランザクションで行い、削除件数が検証と合わなければ**必ずロールバック**する。
- 同時実行は advisory lock で直列化する。監査のハッシュ連鎖は `appendAuditTx`（別の advisory lock）が守る。

## 5. 終了コード

| コード | 意味                                                                         |
| ------ | ---------------------------------------------------------------------------- |
| 0      | 成功（dry-run の成功を含む）                                                 |
| 2      | ガード不成立・引数不正で中止。**DB は変更していない**                        |
| 1      | 想定外の失敗（接続不能など）。この場合も削除と監査追記は同一トランザクション |

## 6. 実施記録

- 実施したら、日時・DB 名・cutoff・削除件数・監査 `id` を [`17-staging-access-jwt-rollout-20261106.md`](17-staging-access-jwt-rollout-20261106.md) §3 と同じ形式で追記する。セッション ID・接続文字列・秘密は書かない。
- 2026-11-06 の手作業削除（21 件）は本スクリプト導入前のため監査行が無い。**遡って作ることはできない**（`audit_log` は追記のみ）。以後の失効は本手順で行う。

## 7. 影響と切り戻し

- 削除されたセッションの利用者は再ログインが必要になる（cookie が無効になる）。業務データは消えない。
- DB のバックアップからの復元は**しない**（他のデータを巻き戻すため）。誤って多く消した場合も、利用者に再ログインを依頼する。
- 有効なセッションを残したまま古いものだけ消す場合は、`--cutoff` を正しく設定する（既定で有効セッションがあれば中止する）。

## 8. テスト

```bash
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/session-revoke.test.ts
```

- 正常系: 削除件数の一致、監査行が 1 行だけ増えること、監査ハッシュ連鎖（`db:verify` 相当）が OK。
- 中止系: DB 名不一致・件数不一致・上限超過・cutoff 不正（形式・未来）・有効セッション・cutoff 以後のセッションで、削除も監査追記もしない。
- CLI: `--yes` を付けない既定が dry-run であること、ガード不成立が終了コード 2 であること。

## 9. 未確認・制約

- 本番 DB での実行は未実施（この PR はコード・手順・テストのみ）。実施は所有者の Y/N を得てから行う。
- `audit_log` の監査行は削除できない（追記のみ）。誤った実行も取り消せないため、dry-run の確認を省略しない。
