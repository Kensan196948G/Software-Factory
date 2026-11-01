# データベース（ローカル PostgreSQL）

正本: 詳細仕様書 V1.0 5章（ENT-01〜11）。実装: `db/migrations/0001_init.sql`。

## 1. 接続

| 用途       | 接続                                                  | 備考                                                            |
| ---------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| アプリ     | `postgresql:///mirai_sf_dev?host=/var/run/postgresql` | ローカルunix socket（peer認証）。**インターネットへ公開しない** |
| migration  | 同上（`MIGRATION_DATABASE_URL`）                      | 破壊的変更は行わない・additiveのみ                              |
| 結合テスト | `mirai_sf_test`                                       | テスト開始時に `public` スキーマを作り直す（`_test` のみ）      |
| Preview    | `mirai_sf`（任意）                                    | 必要なら `DATABASE_URL` を切替。既定は開発DB                    |

ロール: ローカルは OS ユーザー `kensan`（開発用）。CIは `postgres`。本番移行時は専用の最小権限ロールを作る（Backlog）。

## 2. テーブル

| テーブル                 | 仕様ID | 内容                                                                                                                                   |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `department`             | ENT-05 | 19部署（code, name, short_name, role_desc, sort_order）                                                                                |
| `catalog_tool`           | ENT-06 | 118道具（id: keiei-01, dept_code, signal g/y/r, seed_candidate）                                                                       |
| `app_user` / `user_role` | —      | 利用者と役割（requester/desk/approver）                                                                                                |
| `session`                | —      | セッション（トークンはSHA-256で保存、acting_role, csrf_token, expires_at）                                                             |
| `request`                | ENT-01 | 依頼。受付番号（REQ-YYYY-NNNN）・状態12・信号・注文書版・論理削除                                                                      |
| `request_counter`        | —      | 年ごとの採番（トランザクション内で原子的に増加）                                                                                       |
| `request_history`        | ENT-02 | 追記型の変更履歴（受付・内容を編集・状態を「〜」に変更）                                                                               |
| `comment`                | ENT-03 | コメント（差戻し理由も残す）                                                                                                           |
| `approval`               | ENT-07 | 承認・差戻し・見送りの記録（決定色・候補色・チェック結果・版）                                                                         |
| `attachment`             | ENT-04 | 添付のメタ情報のみ（name, size, sha256）                                                                                               |
| `draft`                  | 5-6    | 旧・下書き（利用者ごとに1件。0006 で `draft_item` へ引き継ぎ済み）                                                                     |
| `draft_item`             | 5-6    | 下書き（利用者ごとに複数件。本人のみ・新しい順）                                                                                       |
| `ops_state`              | —      | 運用・DevOps・SecOps の画面状態（id=1 の単一JSONB・版番号）                                                                            |
| `mail_outbox`            | —      | 承認依頼メールの送信キュー（依頼の状態遷移と同じトランザクションで積む。`sending` で確保して二重送信を防ぎ、失敗しても業務は止めない） |
| `audit_log`              | ENT-11 | 監査ログ（追記のみ・ハッシュ連鎖・UPDATE/DELETEをトリガで拒否）                                                                        |
| `idempotency`            | —      | 操作キー（二重登録の防止）                                                                                                             |
| `schema_migrations`      | —      | 適用済みmigration                                                                                                                      |

## 3. 制約（主なもの）

- `request.title` ≤ 60、`problem`/`purpose` ≤ 2000、`users` ≥ 1、`scope` ≥ 1、`criteria` 1〜8件。
- `status` は12値、`signal_decided`/`catalog_tool.signal` は g/y/r、`kind` 4値、`parties` 3値。
- 受付番号は一意（`id`）、連番は一意（`seq`）。
- 取消は `deleted=true`（論理削除）。データは消さない。

## 4. 手順

```bash
pnpm db:migrate     # 空DBから再実行可能（適用済みはskip）
pnpm db:seed        # 部署・道具・管理者・（空なら）見本9件
pnpm db:verify      # 19部署/118道具/青52黄47赤19/採番/監査ハッシュ連鎖
pnpm db:reset       # _dev/_test のみ・--yes 必須（全業務データを作り直す）
```

### 空DBからの再現（受入）

```bash
dropdb mirai_sf_dev && createdb -O "$USER" mirai_sf_dev
pnpm db:migrate
pnpm db:seed
pnpm db:verify
```

### バックアップ / 復元

```bash
pg_dump -Fc -d mirai_sf_dev -f mirai_sf_dev_$(date +%Y%m%d).dump
pg_restore -c -d mirai_sf_dev mirai_sf_dev_YYYYMMDD.dump
```

### ロールバック方針

migrationはadditiveのみ。破壊的変更は行わない。障害時はバックアップから復元し、コードは直前のSHAへ戻す（`docs/deployment.md`）。

### 追加migration（2026-10-28）

| ファイル                     | 内容                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `0002_ops_state.sql`         | `ops_state`（id=1 の単一JSONB・版番号）                                               |
| `0003_mail_outbox.sql`       | `mail_outbox` と索引（承認依頼メールの送信キュー）                                    |
| `0004_mail_outbox_claim.sql` | `sending` 状態・`claimed_at`・「送信済みなら `sent_at` 必須」の制約（二重送信の防止） |
| `0005_mail_reminder.sql`     | `kind='reminder'`・`reminder_date`・1日1回の unique 索引（滞留通知）                  |
| `0006_drafts_multi.sql`      | `draft_item`（複数下書き）と旧 `draft` からの引き継ぎ                                 |
| `0007_mail_retry.sql`        | `next_attempt_at`（失敗時の指数バックオフ再送）と索引                                 |

### 追加migration（開発ライン Phase 1・2026-10-31）

`0008_devline_foundation.sql`。判断の理由は `docs/devline/adr-001-devline-foundation.md`。既存の表は変更しない。

| テーブル         | 仕様ID | 内容                                                                                                          | 更新               |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------- | ------------------ |
| `order_snapshot` | —      | 承認済み注文書の版固定（正規化した YAML、sha256、envelope、承認、対象リポジトリ、base_sha、policy の版）      | 追記のみ           |
| `handoff_intent` | —      | 外部呼び出しの前に残す意図。補助状態 `intent/sent/succeeded/unknown/failed`。unique(依頼, 版, リポジトリ, op) | 遷移のみ・削除不可 |
| `job`            | ENT-08 | 実行ジョブ。状態は仕様 4-3 の15値。lease と fencing_token、修正回数・時間・費用（円の整数）・停止理由         | 遷移のみ・削除不可 |
| `job_attempt`    | ENT-08 | 実行の試行。終わった試行は変更不可                                                                            | 終了まで・削除不可 |
| `job_event`      | ENT-08 | 出来事（遷移、遅れて捨てた書き込みなど）                                                                      | 追記のみ           |
| `job_artifact`   | ENT-08 | 成果物のハッシュと参照。PR 候補の本文もここ                                                                   | 追記のみ           |
| `verification`   | ENT-09 | 検証結果。`delivery_id` unique。`source` は `fake_ci` / `ci` のみ（Agent の申告を入れない）                   | 追記のみ           |

- **追記のみ**: `audit_log` と同じく BEFORE UPDATE/DELETE トリガで拒否する。TRUNCATE は拒否しない。
- **遷移**: `job` と `handoff_intent` は BEFORE UPDATE トリガで遷移表（`devline_job_transition_allowed` / `devline_handoff_transition_allowed`）を確かめる。正本は `src/shared/devline.ts`。
- **依頼の削除**: 上の表から `request` への外部キーは `on delete restrict`。開発ラインの行がある依頼は `delete from request` できない。`pnpm db:reset` は `truncate ... cascade` なので通る。
- **ロールバック**: additive のみ。`db.ts` の方針どおりバックアップからの復元か forward fix。上の7表と関数は既存の表から参照されないので、アプリを戻すだけで影響は残らない。

### 追加migration（開発ライン最終段・2026-11-01）

`0012_devline_release.sql`。additive（表と列の追加だけ）。job の状態と遷移表は変えない。

| テーブル／列        | 仕様ID | 内容                                                                                                                       | 更新                 |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `release`           | ENT-10 | 1 job・1 行。PR、head、merge の途中経過と結果、tree の照合、成果物の digest、配備の承認（SHA + digest + 環境）、結果、戻し | 条件付き更新         |
| `release_approval`  | ENT-10 | 人の承認の行（merge / deploy / rollback）。承認者は必須で役割は `approver` のみ。同じ head の merge の承認は1行            | 追記のみ             |
| `release_attempt`   | ENT-10 | 成果物の作成・配備・戻しの試行。worker の lease と fence を持つ。環境のいまの版は `deployed_digest` の最新で決まる         | 終わるまで・削除不可 |
| `app_user.is_agent` | —      | AI・自動処理の利用者の印。承認の経路は DB のこの列を見て拒否する                                                           | 既定 `false`         |

- 同じ環境で動く配備と戻しは1つだけ（`release_attempt_env_active`）。二重押下は unique の違反で ERR-301 にする。
- job は lease を持てない状態（`merged` など）なので、worker の書き込みは attempt の fence で守る。
- **ロールバック**: `release_attempt` → `release_approval` → `release` の順に落とし、`is_agent` を落とす。既存の表から参照されないので、アプリを戻すだけで影響は残らない。

## 5. インデックス

- `request (status, updated_at desc)` / `(dept_code)` / `(applicant_user_id)` / `(approver_user_id)` / `(updated_at desc)`
- `request_history (request_id, at)` / `comment (request_id, at)` / `approval (request_id, at)`
- `catalog_tool (dept_code, sort_order)`
- `audit_log (at desc)` / `(target_type, target_id)`

## 6. 監査ログのハッシュ連鎖

`hash = sha256(prev_hash + "|" + canonical(payload))`。`payload` は日時・操作者・役割・操作・対象・結果・差分・相関ID。
書き込みは `pg_advisory_xact_lock(918273645)` で直列化。`verifyAuditChain()` が全件を再計算して検証する。
