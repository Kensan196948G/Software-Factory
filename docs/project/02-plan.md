# MVP Planning（2026-10-28）

## 1. Goal → Current → Scope → Gap → Priority

- Goal: 個人利用可能な受付ステーションMVPを、DeepSeek Harness / GitHub / OpenDesign / Cloudflare / ローカルPostgreSQLで構築し、Preview上で主要フローを実操作できる状態にする。
- Current: 仕様書とHTML試作のみ。アプリ・DB・CI・Deployなし（`00-assessment.md`）。
- Scope: `01-mvp-scope.md` のIn Scope 9画面＋API＋DB＋CI＋Preview。
- Gap: G-01〜G-10（Assessment §5）。
- Priority:
  1. **P0**: DBスキーマ・採番・状態遷移・権限・受付CRUD・承認（F1/F2の土台）
  2. **P0**: 監査ログ・入力検証・エラーコード
  3. **P1**: 画面（ホーム／新規／ボード／一覧／詳細／状態変更／データ／カタログ）
  4. **P1**: テスト（unit/integration/E2E）・CI
  5. **P1**: Cloudflare Preview・Health・Runtime確認
  6. **P2**: ドキュメント・制限・復旧手順

## 2. Implementation Plan（小さく検証可能な単位）

| # | 作業 | 完了条件 | 状態 |
|---|---|---|---|
| 1 | Assessment・Scope・Plan | 文書化 | 完了 |
| 2 | Repository作成・scaffold・.gitignore | mainに初期構成、CI雛形 | 進行中 |
| 3 | DB migration・seed（19/118/9） | `db:verify` 成功 | 完了（ローカル実測） |
| 4 | ドメイン（信号・条件・ものさし・遷移・権限） | unitテスト | 実装済み |
| 5 | API（auth/home/requests/transitions/order/export/catalog/draft/audit） | integrationテスト | 実装済み |
| 6 | 認証・セッション・CSRF・レート制限 | 401/403の検証 | 実装済み |
| 7 | **WebUI仕様承認（OpenDesign＋Y/N）** | 明示的なY | **承認待ち** |
| 8 | Frontend（9画面・全状態・A11y） | E2E 3フロー | 未着手（承認後） |
| 9 | テスト（unit/integration/E2E） | 全PASS | 一部実装 |
| 10 | CI（型・Lint・Test・Build・秘密・migration） | Required Checks | 未着手 |
| 11 | Cloudflare Preview（Worker＋Tunnel＋Secrets） | URLで操作可能 | 未着手 |
| 12 | Preview実動作検証（UI/API/DB/Health/Log） | Evidence取得 | 未着手 |
| 13 | ドキュメント・最終報告 | 完了条件32項目 | 未着手 |

## 3. Affected Files（見込み）

```
src/api/            … Fastify API（server/app/config/db/auth/audit/repo/service/seed/schemas）
src/shared/         … ドメイン（信号・条件・遷移・出力形式）※APIとWebで共有
src/web/            … React SPA（承認後）
db/migrations/      … 0001_init.sql（additiveのみ）
db/seed/            … departments.json / catalog.json / demo-requests.json
scripts/            … db.ts / local-run.mjs / bootstrap-local.mjs / smoke.ts / design-shot.mjs
worker/             … Cloudflare Worker（静的配信＋APIプロキシ）
tests/              … unit / integration / e2e
docs/               … project / design / database / api / test / deployment / limitations
.github/workflows/  … ci.yml
```

## 4. Database Impact

- 新規DB `mirai_sf_dev` / `mirai_sf_test`（ローカルPostgreSQL 16）。
- テーブル15: department / catalog_tool / app_user / user_role / session / request / request_counter / request_history / comment / approval / attachment / draft / audit_log / idempotency / schema_migrations。
- 制約: 状態・信号・区分のCHECK、件名60・本文2000・条件1〜8件、`deleted` による論理削除、監査ログの追記トリガ。
- 破壊的変更なし（additive migrationのみ）。`reset` は `_dev`/`_test` かつ `--yes` のときだけ。

## 5. API Impact

- 外部公開APIは新規。`/api/auth/*`、`/api/home`、`/api/requests*`、`/api/draft`、`/api/catalog/*`、`/api/export.*`、`/api/import`、`/api/audit-logs`、`/healthz`、`/readyz`。
- 状態遷移・権限・信号判定はサーバが正。クライアントの役割を信用しない。
- エラーは `{error:{code,message,details,correlationId}}`。仕様のERR-001〜405に対応。

## 6. UI Impact

- 新規9画面（SCR-01/02/03/04/05/06/07/08/21）。
- デザインはOpenDesign `human-approachable` ＋ `tech-utility` の密度。信号色は青/黄/赤でブランド色と分離。
- 空・読込・入力エラー・通信エラー・成功を全画面で設計。

## 7. Test Plan

| 層 | 対象 | 手段 |
|---|---|---|
| Unit | 信号R1〜R6、条件チェック26語、ものさし、遷移表・権限、承認チェック、YAML/CSV | vitest |
| Integration | API（login/CSRF/採番/遷移/承認/差戻し/取消/出力/取込/監査連鎖） | vitest + Fastify inject + 実PostgreSQL |
| E2E | F1登録、F2承認、F3進める・差戻す、空/エラー状態 | Playwright |
| 非機能 | キーボード操作、色以外の判別、レスポンシブ（768/375） | Playwright |
| DB | 空DB→migration→seed→verify | scripts/db.ts |
| CI | typecheck/lint/test/build/secret scan/migration validate | GitHub Actions |

## 8. Security Impact

- 秘密情報は `~/.config/mirai-sf/local.json`（0600）と環境変数のみ。リポジトリ・ログ・Seed・画面に出さない。
- 認証: scrypt、HttpOnly/SameSite Cookie、CSRFトークン、Origin検証、ログイン試行制限。
- 認可: 役割はサーバ側で判定。承認は承認者のみ。自己承認は設定で許可（個人MVPの制限として明記）。
- 通信: HTTPS（Cloudflare）。Worker → origin は共有秘密ヘッダ。ローカルDBは非公開。
- 監査: 追記のみ・ハッシュ連鎖・UPDATE/DELETEをトリガで拒否。
- 入力: zodによる型・列挙・長さ検証。SQLはパラメータ化。

## 9. Deployment Impact

- Cloudflare Worker `mirai-sf-preview`（静的アセット＋`/api/*`をTunnel originへプロキシ）。
- 専用 Tunnel `mirai-sf-preview` → `127.0.0.1:8782`（systemd user unit `mirai-sf-api`）。
- ホスト名 `mirai-sf-preview.mirai-dx-platform.com`（DNSはCloudflare API）。
- Production正式環境は対象外。デプロイはPreview環境のみ。

## 10. Risk / Rollback

| リスク | 検知 | 対応 |
|---|---|---|
| Tunnel/DNS設定失敗 | 疎通不可 | Blocker報告。ローカルURLで検証継続 |
| CI課金/権限不足 | Actions起動不可 | ローカル同一手順の結果をEvidenceにし、未実行を明記 |
| DB破損 | verify失敗 | `pg_dump`バックアップ→復元。migrationはadditive |
| 仕様解釈違い | テスト失敗 | 詳細仕様書のIDに戻って修正 |
| 自己承認の統制 | 設計レビュー | 設定で無効化可能。本番移行時にSSO＋複数ユーザー |

Rollback:
- アプリ: 直前のリリース（git SHA）へWorker/Nodeを戻す。
- DB: migrationはadditiveのみ。破壊的変更は行わない。万一は `pg_dump` から復元（`docs/07-deployment.md`）。
- Preview: Workerのversionを `wrangler rollback` で戻す。
