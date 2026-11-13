# 本番の文書・テスト同期（2026-11-13 / c687363d）

作成: 2026-11-13 19:25 JST。対象: 本番（`sf-prod.mirai-dx-platform.com`、API `127.0.0.1:8783`、DB `mirai_sf_prod`）。状態: **実施記録**（本番は `c687363d` で稼働中。製品コードは `797f8a06` と同一）。時刻はすべて JST。実測したものだけを書き、実測していないことは「未実施」「未計測」と書く。

## 1. 承認と配備対象

- 承認: 2026-11-13 15:50〜15:57 の所有者の数字選択「1, 2」のうち (2)。対象は「(1) の PR をマージし、main の push CI が success した後の SHA」。`797f8a06` からの差分が文書・テスト以外へ広がった場合は、配備前に番号選択で再確認する条件だった（`26` §3）。
- 配備対象: `c687363d72869cdbc884a8942ba9642dc125d658`（PR #174 の squash マージ。2026-11-13 18:49:08 JST）。
- 差分 `797f8a06..c687363d`: 6 ファイル、+1,338 / −61。内訳は `docs/design/station-ui.md`・`docs/production/26-release-status.md`・`docs/production/35-mirai-directory-deploy-20261111.md`・`docs/production/36-release-readiness-20261113.md`・`docs/test.md`・`tests/e2e/station-regression.spec.ts`。`src/`・`db/`・`deploy/`・`.github/`・`scripts/`・依存・設定の変更はなく、migration の追加もない。したがって再確認の条件には当てはまらないと判断した。
- main の push CI: run `43404431165`（head `c687363d`）が success（`quality` / `e2e` / `docker`）。

## 2. 実施時刻と実行主体

- 実行: 2026-11-13 19:02:36 JST に `pnpm ops:prod:release c687363d…` が実行された（journal の dsh-subprocess に実行コマンドが残る。**別セッションのエージェントによる実行**であり、本書の作成者（Lead）は実行していない）。本書の作成者は、事後の状態・受入・バックアップを実測して記録した。
- 事前バックアップ: `mirai_sf_prod-20261113T100249Z`（dump 157,141B、sha256 `b4052279…`）。R2 バケット `mirai-sf-prod-backups` へ 19:03:03 JST に送信（`uploadedAt=2026-11-13T10:03:03Z`）。
- 切替: 19:03:04 JST に unit を停止・起動（journal の `Stopping` / `Started` が同一秒）。healthz の commit が `c687363d` に一致した。
- 停止時間: journal 上は 1 秒未満。外部からの連続監視は行っておらず、**可用性の連続性は計測していない**。

## 3. 事前確認（実測）

| 項目                 | 実測値                                                                     | 実測時刻 |
| -------------------- | -------------------------------------------------------------------------- | -------- |
| exact-main CI ゲート | `ops:prod:release --dry-run c687363d…` が「確認済み（exit 0）」            | 19:03    |
| 未適用 migration     | なし                                                                       | 19:03    |
| unit の参照先        | `mirai-sf-prod-api.service` は `current` を参照している                    | 19:03    |
| ロールバック先       | `ops:prod:rollback --dry-run 797f8a06…` が exit 0                          | 19:00    |
| オフサイト           | `ops:prod:offsite-status --count 2` が OK（最新世代の鮮度 43 分、R2 あり） | 19:00    |
| 配備前の機械受入     | `ops:prod:acceptance 797f8a06…` が 14/14 PASS（exit 0）                    | 19:00    |

## 4. 配備後の受入（実測）

- ヘルスチェック: 19:22 に 1 回実行。`Result=success` / `ExecMainStatus=0`。`healthCommit=c687363d…`、`authStatus=ready`、**警告 0**（commit が main と一致）。
- 機械受入: `pnpm ops:prod:acceptance c687363d… --json` が **14/14 PASS**（exit 0、19:22:08）。healthz 200・readyz 200・auth `ready`・5xx 0・DB は `app_user=3` / `audit_log=15` / `request=0` / `session=7` / `migration=0017_mirai_directory.sql`。
- 公開 URL: 未認証で `https://sf-prod.mirai-dx-platform.com/` は **302 → Cloudflare Access**。
- 証跡: `~/.local/state/mirai-sf/evidence/release-readiness-20261113/acceptance-c687363d-20261113T102208Z.json`（このホストのローカル保存。リポジトリには含めない）。

## 5. 状態

- 本番: `current` → `releases/c687363d72869cdbc884a8942ba9642dc125d658`。`mirai-sf-prod-api` は active（MainPID 2729381、起動 2026-11-13 19:03:04、NRestarts 0、Result=success）。`mirai-sf-prod-tunnel` も active。
- 本番と main の差: 本書をマージする前は **0**。本書のマージで main が文書 1 commit 進むため、healthcheck の「main と一致しません」の警告は再び出る見込み（`26` §2 と同じ扱い）。
- 製品コード・DB スキーマ・設定・依存は `797f8a06` と同一。利用者に見える画面・API の挙動は変わらない。

## 6. 未確認・残リスク

- 人による OTP ログイン後の画面確認と、別の利用者による業務受入（受付 → 承認 → 注文書）は**未実施**。エージェントだけでは実施できない。
- 配備直後の 5xx・エラーの観測は、機械受入が確認した範囲（5xx 0）に限る。1 時間の継続観察は未実施。
- 品質状態は変わらない。品質工作台の親 project には 2026-11-13 付けの open の不具合が 7 件あり、テストレポートは v5 のまま（判定は NO-GO）。本同期はリリース可否の判断を変えない（`36` §7・§10、`26` §4）。
- 承認の記録は `26` §3 の 2026-11-13 15:50 の行である。本書は実施の記録であり、新たな承認を作るものではない。

## 7. 参照

- `26-release-status.md`（本番の状態・承認の正本）
- `24-production-deploy-runbook.md`（配備の手順と前提条件）
- `36-release-readiness-20261113.md`（2026-11-13 のリリース準備の実測）
- PR #174（`c687363d`）
