# 本番 readiness レビュー（2026-11-18 / Staging・本番の実測と残リスク）

作成: 2026-11-18 11:30 JST。対象: Staging（`mirai_sf` / `127.0.0.1:8782` / unit `mirai-sf-*`）と本番（`mirai_sf_prod` / `127.0.0.1:8783` / unit `mirai-sf-prod-*`）、実測時の main `bb7c2426`。状態: **レビュー（実測）**。時刻はすべて JST。

- 本書は「Staging の構築状況・主要機能の動作・必要なテスト・監視／復旧手順」を**読み取りだけ**で実測し、「本番に進むための不足と残リスク」を整理したものである。ソース・設定・DB・サービス・Git は変更していない。
- 実測は 2026-11-18 11:15〜11:27 JST に実施した。**測定中に本番の状態が変わった**（11:18:14 に `17c91f43` → `bb7c2426` へ配備。Lead の作業。§2-1）。各値には測定時刻を付ける。
- 実測の後（11:30 頃）に main は `bb7c2426` → `d9efe680`（文書のみ 6 ファイル、+407/−26）へ進んだ。**本番と Staging が動かしているのは引き続き `bb7c2426`** である（11:32 に `readlink` と `/healthz` で再確認）。
- 実測していないことは「未確認」「未実行」と書く。`pnpm test`（integration）と `pnpm test:e2e` は**実行していない**（他の作業と競合するため）。代わりに CI の実測を根拠にする（§4）。

## 0. 結論（要約）

| 観点                           | 判定                                                                                                       | 根拠                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Staging の稼働                 | **正常**                                                                                                   | `/healthz` 200・`/readyz` 200・`commit=bb7c2426`（main と同一）・`db.ok=true`・unit active・`NRestarts=0`（§1） |
| 本番の稼働                     | **正常**                                                                                                   | `/healthz` 200・`commit=bb7c2426`・`environment=production`・`usersActive=2`・unit active・`NRestarts=0`（§2）  |
| 本番と main の差               | 11:19 時点で **0**。11:32 時点では 1 commit（文書のみ）                                                    | `current` = `releases/bb7c2426…`、main は `bb7c2426` → `d9efe680`（§2-3）                                       |
| 監視（5 分・毎時・日次・週次） | **動作している**。ただし通知が無く、検知は人の巡回依存                                                     | 保持期間内で本番 healthcheck 1110 OK / 1 失敗、バックアップ毎時成功、復元訓練 11-15 成功（§3）                  |
| 復旧（RTO/RPO）                | RPO は 7 日実測で**閾値内**（60 分超 0 件）。RTO は**部分実測**（復元〜起動 40.8 秒）で、全体 RTO は未測定 | `ops:rpo-report` と 2026-11-05 の RTO 訓練記録（§3-4・§3-5）                                                    |
| テスト                         | CI は緑（`bb7c2426` の push CI 3 job success）。ローカルは `typecheck`/`lint` のみ実行                     | CI run `43433387940`、`pnpm typecheck` exit 0、`pnpm lint` exit 0（§4）                                         |
| リリース可（GO）判定           | **未了**                                                                                                   | 業務受入（人間）と quality gate（所有者）が未実施（§6 の P0）                                                   |

**本番に進むための P0 は 2 件**（どちらも AI だけでは完了できない）。P1 は 8 件、P2 は 9 件（§6）。

## 1. Staging の実測

### 1-1. 稼働状態（11:15:57〜11:17 JST）

| 項目                   | 実測値                                                                                                                                                                                                       | 採取方法                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `/healthz`             | **200**、`status=ok`、`commit=bb7c2426a099f56590de3c75458d431f2ab94380`、`environment=staging`、`db.ok=true`（`latencyMs` 6.4）、`auth.status=ready`（`mode=access`、`jwtConfigured=true`、`usersActive=2`） | `curl`                         |
| `/readyz`              | **200**、`status=ready`、`db.ok=true`                                                                                                                                                                        | `curl`                         |
| `mirai-sf-api.service` | `ActiveState=active` / `SubState=running`、MainPID 3407、**NRestarts 0**、`Result=success`、起動 **2026-11-16 12:37:10**、`WorkingDirectory=/home/kensan/.local/share/mirai-sf/current`                      | `systemctl --user show`        |
| `current`              | `releases/bb7c2426a099f56590de3c75458d431f2ab94380`                                                                                                                                                          | `readlink`                     |
| 主要 DB 件数           | `app_user=3`（**有効 2** / 無効 1）、`request=14`、`audit_log=191`                                                                                                                                           | `psql -X`（SELECT のみ）       |
| 役割                   | `approver=2`、`desk=1`、`requester=2`（有効 2 名の内訳を含む）                                                                                                                                               | `ops:user-inventory` と `psql` |

### 1-2. Staging と main の差

- Staging の `commit` は `bb7c2426` で、**実測時点の main と同一**（`git log --oneline bb7c2426..bb7c2426` は空）。autofollow の journal にも `current=bb7c2426… origin/main=bb7c2426…` と記録されている（11:10:10）。11:30 に main が `d9efe680` へ進んだため、11:32 時点では **1 commit（文書のみ）の差**である。
- autofollow は次の実行（11:20 以降）で `d9efe680` を取りに行く。**本書では 11:32 以降の追随結果を確認していない**（未確認）。
- 起動時刻（2026-11-16 12:37:10）はホストの再起動（同日 12:36:56 起動）と一致する。Staging は **再起動後に自動で復帰**している（`Linger=yes`、`Restart=always`、`WantedBy=default.target`、全 unit `enabled`）。

### 1-3. timer と定期ジョブ（11:15 時点）

| timer                                     | 周期                             | 直近           | 次回        | 状態              |
| ----------------------------------------- | -------------------------------- | -------------- | ----------- | ----------------- |
| `mirai-sf-healthcheck.timer`              | 5 分                             | 11:15:03       | 11:20       | active（waiting） |
| `mirai-sf-prod-healthcheck.timer`         | 5 分                             | 11:15:03       | 11:20       | active            |
| `mirai-sf-autofollow.timer`               | 10 分                            | 11:10:10       | 11:20:01    | active            |
| `mirai-sf-prod-backup.timer`              | 55 分（`OnUnitActiveSec=55min`） | 10:29:27       | 11:24:27    | active            |
| `mirai-sf-backup.timer`（Staging・日次）  | 毎日 02:30                       | 11-18 02:30:22 | 11-19 02:30 | active            |
| `mirai-sf-reminders.timer`                | 毎日 08:30                       | 11-18 08:30:14 | 11-19 08:30 | active            |
| `mirai-sf-restore-drill.timer`（Staging） | 日曜 03:30                       | 11-15 03:30:12 | 11-22 03:30 | active            |
| `mirai-sf-prod-restore-drill.timer`       | 日曜 04:30                       | 11-15 04:30:08 | 11-22 04:30 | active            |

- 8 timer すべて `active (waiting)`。直近の実行は全 unit で `Result=success` / `ExecMainStatus=0`。

### 1-4. autofollow（main への追随）

- 直近は **10 分ごとに no-op 成功**（`action=noop exit=0`、11:10:12 が最後）。
- 保持期間（2026-11-14 14:46 以降・約 3.85 日）の実測: **成功 550 / 失敗 6**（失敗率 1.1%）。失敗はすべて `fatal: unable to access 'https://github.com/…': Could not resolve host: github.com` で、**古い情報で配備しない（fail-closed）** 設計どおりに中止している（11-17 18:00、11-18 06:00 など）。
- 失敗時は `OnFailure` で `alerts.jsonl` に記録されるが、**外部通知は無い**（§3-6）。

### 1-5. バックアップ・日次保守（Staging）

- 日次バックアップ: 11-18 02:30:23 に `backup OK db=mirai_sf … size=209313 tables=30 offsite=0`（Staging は R2 送信なしの設計）。保持 dump 85 件、R2 記録 0 件。
- 日次保守（reminders）: 11-18 08:30:15 に成功。ただし `{"mode":"off","queued":0,"draftsPurged":0,"note":"MAIL_MODE=off のため送信しません"}` で、**メール送信と下書き削除は実質動いていない**（`MAIL_MODE=off`）。

## 2. 本番の実測

### 2-1. 測定中に状態が変わった（重要）

| 時刻        | 出来事                                                                                           | 根拠                   |
| ----------- | ------------------------------------------------------------------------------------------------ | ---------------------- |
| 11:16:09    | 本番 `/healthz` は `commit=17c91f43`、`usersActive=3`                                            | 本書の `curl`          |
| 11:16:27    | 監査に `user.roles`×2・`user.deactivate`×1（2 アカウント化）。`audit_log` 15 → 18                | `psql`（SELECT）、`45` |
| 11:16:51-52 | `mirai-sf-prod-api.service` 再起動（設定反映）                                                   | `journalctl`           |
| 11:18:14    | `current` 切替 `17c91f43` → `bb7c2426`、unit 再起動、11:18:15 に healthz OK（`commit=bb7c2426`） | `journalctl`、`46`     |

- 上の 11:16 と 11:18 の変更は **Lead が実施した**もので、本書の作業ではない（`45`・`46`）。以降の本番の値はすべて `bb7c2426` 時点のものである。
- したがって、タスク指示にあった「本番は `17c91f43`」という前提は **11:18 以降は成り立たない**。`17c91f43..bb7c2426` の差分は **4 ファイル・+199/−5・すべて `docs/production/`**（`26`・`40`・`41`・`42`）で、`src/`・`db/`・`deploy/`・`.github/`・`scripts/` の変更は **0**（`git diff --stat` で確認。§2-3）。

### 2-2. 稼働状態（11:18〜11:27 JST）

| 項目                   | 実測値                                                                                                                                                                                         | 採取方法                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `/healthz`             | **200**、`status=ok`、`commit=bb7c2426a099f56590de3c75458d431f2ab94380`、`environment=production`、`db.ok=true`（`latencyMs` 0.5〜7.2）、`auth.status=ready`（`mode=access`、`usersActive=2`） | `curl`                              |
| `/readyz`              | **200**、`status=ready`                                                                                                                                                                        | `curl`                              |
| `mirai-sf-prod-api`    | active（running）、MainPID 3563341、**NRestarts 0**、`Result=success`、起動 **11:18:14**                                                                                                       | `systemctl --user show`             |
| `mirai-sf-prod-tunnel` | active（running）、MainPID 3421、`NRestarts 0`、`Result=success`（11:16 時点。配備で再起動していない）                                                                                         | 同上                                |
| `current`              | `releases/bb7c2426a099f56590de3c75458d431f2ab94380`                                                                                                                                            | `readlink`                          |
| 主要 DB 件数           | `app_user=3`（**有効 2** / 無効 1 / 管理者 1）、`audit_log=18`、`request=0`、`session=7`                                                                                                       | `psql -X`（SELECT のみ）            |
| 適用済み migration     | `0017_mirai_directory.sql`（`applied_at` 2026-11-11 21:47:19）                                                                                                                                 | `schema_migrations`                 |
| 定期 healthcheck       | 11:20:00 に **OK**。「origin/main と一致: bb7c2426…」、`usersActive=2`、最新バックアップ 2 分前、オフサイト記録 2 分前、所要 64 ms                                                             | `journalctl`                        |
| オフサイト             | **OK**（直近 2 世代、R2 あり、鮮度上限 90 分）。11:17 時点の最新は `mirai_sf_prod-20261118T012927Z`（157,141B、`uploadedAt` 基準で 47.1 分前）                                                 | `ops:prod:offsite-status --count 2` |

- **`request=0`**。本番 DB には依頼が 1 件も無く、**業務フローは本番で一度も通っていない**（§6 P1-5）。

### 2-3. 本番と main の差

- **11:19 時点は差 0**（`current` = `releases/bb7c2426…` = 当時の main HEAD = Staging の commit）。healthcheck の「デプロイ commit が origin/main と一致しません」警告は**解消**している（11:20 の journal に「origin/main と一致」）。
- **11:32 時点では 1 commit 差**: main は `d9efe680`（`44`・`45`・`46`・`47` の追加と `26`・`42` の更新。**文書のみ 6 ファイル、+407/−26**）。本番と Staging は `bb7c2426` のまま。**`src/`・`db/`・`deploy/` の差分は無い**ので、配備の要否は文書の内容で判断する（コードの差では発生しない）。
- 参考（今回の配備対象の差分の性質）: `git log --oneline 17c91f43..bb7c2426 --stat` は 2 commit / 4 ファイル（`26`・`40`・`41`・`42`）、`+199/−5`。**文書のみ**。CI run `43433387940` はこの SHA のもの（§4-1）。

### 2-4. 2026-11-16 のホスト再起動と復帰（実測）

- `uptime -s` = **2026-11-16 12:36:56**。再起動前 11:33:41 に本番 API は `SIGTERM` で正常停止、起動後に 11:36:19 に自動起動した（journal。時計補正のため journal の表示は 1 時間前になる箇所がある）。
- 再起動直後の healthcheck が **1 回だけ NG**（11:36:21、`ECONNREFUSED`＝API がまだ listen していない）。11:37 のバックアップ、11:40 の healthcheck は成功し、**自動で復帰**した。
- `healthcheck.json` は `totalFailures=5`（prod）/ `6`（staging）、`consecutiveFailures=0`、`lastFailureAt=2026-11-16T02:36:20Z`（両環境がほぼ同時刻）。**この 1 回の再起動以外に、保持期間内の失敗は無い**（§3-2）。

## 3. 監視・復旧の実測

### 3-1. unit と timer の状態（本番・Staging 共通の確認）

| unit                                | 種別            | 直近結果                              | 備考                                                                  |
| ----------------------------------- | --------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `mirai-sf-prod-healthcheck`         | 5 分・oneshot   | `Result=success`（11:20:00）          | `OnFailure` あり。`MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN=90`            |
| `mirai-sf-healthcheck`（Staging）   | 5 分・oneshot   | `success`（11:20:00）                 | `OnFailure` あり                                                      |
| `mirai-sf-prod-backup`              | 55 分           | `success`（10:29:39、所要 10.7 秒）   | `OnFailure` あり。`offsite=1`、30 テーブル、157,141B                  |
| `mirai-sf-backup`（Staging）        | 日次 02:30      | `success`（11-18 02:30:23、209,313B） | **`OnFailure` なし**                                                  |
| `mirai-sf-prod-restore-drill`       | 週次 日曜 04:30 | `success`（11-15 04:30:41）           | `OnFailure` あり                                                      |
| `mirai-sf-restore-drill`（Staging） | 週次 日曜 03:30 | `success`（11-15 03:30:45）           | **`OnFailure` なし**                                                  |
| `mirai-sf-reminders`                | 日次 08:30      | `success`（11-18 08:30:15）           | **`OnFailure` なし**。**本番に相当する unit/timer が無い**（§6 P1-2） |
| `mirai-sf-autofollow`               | 10 分           | `success`（11:10:12）                 | `OnFailure` あり                                                      |

- unit ファイルは、`deploy/systemd/` と実機 `~/.config/systemd/user/` が **9 unit / 7 timer で一致**（`diff` で確認）。ただし `mirai-sf-reminders.timer` は **repo に存在しない**（実機のみ。§6 P2-4）。
- `systemctl --user --failed` に **mirai-sf 系の失敗は無い**（他プロジェクトの unit 5 件が failed で表示されるため、人の巡回時は名前で絞る必要がある）。

### 3-2. 可用性の材料（保持期間内の実測）

| 指標                 | 本番                        | Staging             |
| -------------------- | --------------------------- | ------------------- |
| healthcheck 成功回数 | **1110**                    | **1109**            |
| healthcheck 失敗回数 | **1**（11-16 の再起動直後） | **1**（同）         |
| 参考: 成功率         | 99.91%（1110/1111）         | 99.91%（1109/1110） |

- 対象は 2026-11-14 14:46〜2026-11-18 11:25 の **約 3.85 日**。**journal の保持が約 3.9 日しかない**ため、**月間可用性（目標 99.5%）は依然として測定できない**（§6 P1-4）。これは `07` §3-3・§5 の既知の制約と同じ。

### 3-3. 復元訓練（週次・実測）

- 本番: 11-15 04:30:41 に成功。復元先の検証は **30 テーブル / 部署 16 / 道具 118 / 利用者 3 / 依頼 0 / 部署外部キー不整合 0 / 監査ログのハッシュ連鎖 15 件 OK / `verify` 成功**。一時 DB は削除済み。
- Staging: 11-15 03:30:45 に成功（依頼 14 件・監査ハッシュ 188 件 OK）。
- いずれも `drill OK source=… backup=mirai_sf…-2026111?T…Z.dump` を journal に残している。

### 3-4. RPO（7 日間の実測、`ops:rpo-report --days 7`）

| 系列                  | 期間内の間隔 | 最大間隔      | p95   | 60 分超  | 最新からの経過 | 判定         |
| --------------------- | ------------ | ------------- | ----- | -------- | -------------- | ------------ |
| ローカル dump（本番） | 190          | **55:01.590** | 55 分 | **0 件** | 3.7 分         | ok（exit 0） |
| R2 送信成功記録       | 190          | **55:06.269** | 55 分 | **0 件** | 3.5 分         | ok           |

- 対象期間 2026-11-11T02:21Z〜2026-11-18T02:21Z。dump 383 件（manifest 無し 0）、R2 記録 406 件。**RPO 1 時間の目標に対して、保持されている 7 日間は閾値内**。
- 限界: これは**残っているファイルの時刻の実測**であり RPO の保証ではない。R2 上の実体の存在・復元可否は別（`prod-offsite-drill` の範囲）。ホスト停止中は計測できない。

### 3-5. RTO（部分実測。全体は未測定）

- `~/.local/state/mirai-sf-prod/rto-drill/rto-drill-20261105T104915Z.json`（2026-11-05 19:48:34〜19:49:15）: `result=ok`、**`totalSeconds=40.847`**、`targetMinutes=30`、`withinTarget=true`、`source=r2`（R2 から取得）、復元先は一時 DB、`release.commit=8d578ca3`、バックアップ鮮度 12 分。
- 段階別: 検知 0.067 秒 / 判断 0.170 / **R2 取得 7.404** / 復元 0.785 / **検証 30.601** / API 起動確認 1.119 / 切替判断 0.007 / 後片付け 0.628。
- **限界**: 判定は「切替可能（復元・検証・API 起動が成功。本番の切替・DNS・Access は未実施）」。**本番の切替・Access 確認・受付再開を含む全体 RTO は未測定**（2026-11-05 の 1 回のみで、`rto-drill` に timer は無い）。§6 P2-3。

### 3-6. 失敗の記録と通知

- 失敗は `~/.local/state/mirai-sf/alerts.jsonl` と journal に残る（`OnFailure` のローカル記録）。保持 36 行の内訳: `mirai-sf-autofollow` 24、`mirai-sf-prod-healthcheck` 6、`mirai-sf-healthcheck` 3、`mirai-sf-prod-backup` 1、検証用 2。
- **外部通知（メール・Slack 等）は未実装**。5 分間隔の監視は動いているが、**気づくのは人**であり、MTTD は定義されていない（§6 P1-3）。

## 4. テストと CI の実測

### 4-1. CI（`bb7c2426` の push CI）

| job       | 結果        | 開始〜終了（UTC）  | 所要       |
| --------- | ----------- | ------------------ | ---------- |
| `quality` | **success** | 13:24:36〜13:32:41 | 8 分 5 秒  |
| `e2e`     | **success** | 13:32:43〜13:38:25 | 5 分 42 秒 |
| `docker`  | **success** | 13:32:43〜13:34:07 | 1 分 24 秒 |

- run `43433387940`（`event=push`、`branch=main`、`headSha=bb7c2426…`、全体 13 分 53 秒、conclusion success）。`quality` のステップは audit / typecheck / lint / unit / migration（空 DB・冪等）/ seed / db:verify / integration / build / secret scan のすべて success。
- `gh run list --branch main --limit 5` の最新 5 件はすべて success（うち 1 件は Dependabot の別ワークフロー）。
- 注意: `e2e` job のステップ名は「**E2E（9シナリオ）**」だが、実行は `pnpm exec playwright test`（全 spec）で、`tests/e2e/` は **8 spec ファイル + `auth.setup.ts`**。**ステップ名と実態が一致しておらず、CI から件数も読めない**（§6 P2-7）。

### 4-2. ローカルで実行した検証（11:19〜11:20）

| コマンド                                   | 結果     | exit  |
| ------------------------------------------ | -------- | ----- |
| `pnpm typecheck`（tsc ×3）                 | エラー 0 | **0** |
| `pnpm lint`（`eslint . --max-warnings=0`） | 指摘 0   | **0** |

- **未実行**: `pnpm test`（integration。`mirai_sf_test` を使うため他作業と競合）、`pnpm test:e2e`、`pnpm build`、`pnpm db:verify`、`pnpm test:ops`。理由は上記の競合回避で、**CI の success を代替根拠**にしている（対象 SHA は `bb7c2426`）。

### 4-3. テスト資産の現状（リポジトリ実測）

| 区分                    | ファイル数                                                          | 備考                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/`           | **44**（`*.test.ts`）+ `setup-env.ts`                               | `36` §9 では `5227b080` 時点で 42 ファイル・987 passed。以降に 3 ファイル追加（`review-ui-wiring` / `station-devmerge-wiring` / `station-modal-wiring`） |
| `tests/integration/`    | **25**（`*.test.ts`）+ 6 補助（harness / fake-github / helpers 等） | CI の `quality` で実行                                                                                                                                   |
| `tests/e2e/`            | **8 spec** + `auth.setup.ts`                                        | Chromium のみ（`playwright.config.ts` の project は `setup` / `chromium`）                                                                               |
| `tests/e2e-legacy/`     | 7                                                                   | 旧画面用。**CI では実行しない**（`36` §4）                                                                                                               |
| `tests/browser-legacy/` | 5                                                                   | 同上                                                                                                                                                     |
| `tests/docker/`         | あり                                                                | `docker` job で実行                                                                                                                                      |

- E2E の件数は `36` §4・§5・§9 の記録（`5227b080` で 21 件 → 回帰 17 件追加後 **38 passed × 2 回**）を引用する。**本書では E2E を実行していない**ため、`bb7c2426` での件数は CI の e2e job success 以上には確認していない。

## 5. 2 アカウント運用の評価（本日 11:16 適用済み）

### 5-1. 実測した構成

| 項目                            | 実測値（11:17〜11:19）                                                 |
| ------------------------------- | ---------------------------------------------------------------------- |
| 本番の利用者                    | 合計 3・**有効 2**・無効 1・管理者 1（`45` の実施記録と一致）          |
| 有効な承認者                    | `<EMAIL_1>`、`is_admin=true`、ロールは **`approver` のみ**             |
| 有効な利用者                    | `<EMAIL_2>`、`is_admin=false`、ロールは **`requester` のみ**           |
| `desk` ロールを持つ有効な利用者 | **0 名**（本番）                                                       |
| `/healthz` の `usersActive`     | 3 → **2**（11:16:27 の変更を反映）                                     |
| 監査                            | 11:16:27 に `user.roles`×2・`user.deactivate`×1（`audit_log` 15 → 18） |

- 隔離環境での業務フロー実測は `44` が **PASS 17 / FAIL 0**（承認者のみで受付→内容確認中→承認待ち、`is_admin=true` の承認者でも自己承認は 403 `ERR-105`、依頼者の自己承認は 409 `ERR-201`）。ただし `44` は `AUTH_MODE=password` の隔離環境で、**本番の Access（OTP+JWT）経路での実測ではない**。

### 5-2. 受付担当が居なくなることの影響（コード読解。画面では未実測）

| 論点                   | 事実                                                                                                                                                                                           | 影響                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 状態遷移               | `src/shared/domain.ts` の `roleCanTransition` は、承認者に「承認済み」「完了」以外の遷移を許す。画面の `canMove`（`station.js`）も `approver` は true                                          | **受付〜承認待ちは承認者 1 名で進められる**（`44` が隔離環境で実測）            |
| 職務分離               | 自己承認は `applicant_user_id` と操作者の比較で拒否（本番既定は拒否。`L-02`）                                                                                                                  | 「依頼者≠承認者」は維持される。**受付と承認は同一人物**になる                   |
| 「あなたの番」表示     | `yourTurn` の承認者分岐は `wait` / `field` / `release_wait` のみ                                                                                                                               | 受付の作業が画面の案内に出ない（**案内が弱くなる**）                            |
| DevOps・運用の操作可否 | 画面の `CAN` 表は `ai` / `check` / `merge` / `stg` / `rollback` / `vtake` / `vfix` / `vrisk` / `gate` / `cfg` を **`desk` 限定**（管理者バイパス無し）。サーバ側（`devline.ts`）は承認者も許可 | **画面から実行できない操作がある**（サーバ API では可）。必要なら設計判断が要る |
| メール再送             | `POST /api/mail/outbox/:id/retry` は `actingRole==='desk'` または管理者のみ                                                                                                                    | 管理者フラグがあるため**実行可能**                                              |

### 5-3. この構成の残リスク（所有者の判断が要る）

1. **承認者の単一障害点**: 有効な承認者は 1 名だけ。その 1 名が無効化・退職・ログイン不能になると**承認できる人が居なくなる**（管理者フラグは残るので利用者管理は可能）。`45` §7 も同じ制約を記録している。
2. **承認者が起票した依頼は承認できない**: 自己承認拒否のため、承認者アカウントで作った依頼は他の承認者が居ないと進められない（`44` で `ERR-105` を実測）。**依頼は必ず利用者アカウントで作る**運用が必要。
3. 選択肢（実施は別作業。**本書では変更していない**）:
   - (a) 承認者アカウントに `desk` ロールを残す（`actingRole` の既定が `desk` になり、承認時に `approver` へ切替）。画面の `CAN` 制約も解消するが、切替忘れの運用が増える。
   - (b) 画面の `CAN` をサーバの権限に合わせる（コード変更。テスト追加が必要）。
   - (c) 現状維持とし、DevOps 操作は API か別アカウントで行う（統制の受容を記録）。

## 6. 本番に進むための不足と残リスク（P0 / P1 / P2）

### P0（リリース可の判定をブロックする。AI だけでは完了できない）

| #        | 項目                                                                              | 根拠（実測・文書）                                                                                                                                                                                               | 影響                                                                                           | 次アクション                                                                                                               | 担当                                                     |
| -------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **P0-1** | **業務受入（本番・人間の OTP ログイン、別利用者による受付→承認→注文書）が未実施** | `/healthz` は `request=0`（本番で業務フローが通っていない）。`42` は計画のみ、`26` §2 は「未実施」、`46` §5 も「業務受入は未実施」と記載。`44` の 17/17 PASS は `AUTH_MODE=password` の隔離環境（§7 に同じ限界） | Access（OTP+JWT）経路と本番 DB での業務成立が未確認のまま。機械受入 14/14 はこの代替にならない | `42` の手順（2 名・30〜45 分）で実施し、`42` §4 の様式に記録。commit は実施直前に `/healthz` で確認                        | **人間**（所有者＋外部利用者）。AI は OTP を受信できない |
| **P0-2** | **品質工作台のレポート v6 と release 門禁（`bb7c2426`）が未申請・未承認**         | `47` §2（レポート作成・門禁申請の REST が無い）、`41` §2、`26` §4。既存の release 門禁 `gate_mwaimwjg_199ab1ff` は main `43e07081` 対象のまま                                                                    | 「リリース可（GO）」の判定が無い。本番配備は NO-GO → GO を意味しない（`26` §4）                | 工作台の対象プロジェクト会話（テストモード）で `report_draft` → `report_draft_save` → `gate_request`。**承認は所有者のみ** | 申請: Lead（AI 可）／**承認: 所有者本人のみ**            |

### P1（本番運用の前提として解消または明示受容が必要）

| #    | 項目                                                     | 根拠                                                                                                             | 影響                                                                                                                          | 次アクション                                                                                               | 担当                                 |
| ---- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| P1-1 | 承認者が 1 名のみ（単一障害点）                          | 本番 `app_user` 有効 2・`approver` は 1 名（`45` §7）                                                            | 1 名の障害で承認が全停止。承認者起票の依頼は誰も承認できない                                                                  | 予備承認者の要否を決定（無効化した外部承認者を戻す等）。依頼は利用者アカウントで作る運用を明記             | 所有者                               |
| P1-2 | **本番に日次保守（`reminders`）が無い**                  | timer 一覧に `mirai-sf-reminders.timer`（Staging）のみ。`mirai-sf-prod-reminders` は unit も timer も存在しない  | `L-10` の前提（滞留通知・下書き TTL・メール再送）が本番で動かない。`MAIL_MODE=off` の間は影響小だが、メール有効化時に欠落する | prod 用 unit/timer を追加するか、Staging の timer を本番 DB に向ける設計を決める（unit 追加は運用変更）    | Lead ＋ 所有者承認                   |
| P1-3 | 失敗の外部通知が無い                                     | `alerts.jsonl` のみ（`07` §5・`24` §9）。保持 36 行、直近は autofollow の DNS 失敗                               | 5 分監視は動くが、**気づくのは人**。MTTD が定義できない。99.5% 目標の運用が属人的                                             | 通知先・方式を決定（`07` §5）。決まるまで「`systemctl --user --failed` と journal を毎日見る」を運用に明記 | 所有者（通知先決定）                 |
| P1-4 | 月間可用性が未測定                                       | journal 保持は **2026-11-14 14:46 以降（約 3.9 日）**。保持期間内は 99.91%（本番 1110/1111）                     | 目標 99.5% の達成を判定できない（`07` §4・§5）                                                                                | journal の保持延長（他プロジェクトのログに押し出されている）を実施し、30 日分を貯める                      | Lead（設定変更は承認後）             |
| P1-5 | 本番 DB で業務フローが一度も通っていない                 | `request=0`（11:19）。E2E・CI は隔離 DB                                                                          | 本番固有の設定（Access・許可メール・監査・注文書）での成立が未確認                                                            | P0-1 の業務受入で同時に解消                                                                                | 人間（P0-1 と同じ）                  |
| P1-6 | 受付と承認の職務分離が無い／画面の一部操作が実行できない | `desk` 有効 0 名（本番）。`station.js` の `CAN` が `desk` 限定、管理者バイパス無し。サーバは承認者も許可         | 統制上「受付と承認が同一人物」。DevOps の投入・merge・配備操作が画面からできない                                              | §5-3 の選択肢 (a)(b)(c) から選び、受容なら記録                                                             | 所有者判断／(b) は Lead              |
| P1-7 | `TC-CATALOG-01` の期待値が 19 部署のまま（現行 16 部署） | `47` §2、`26` §4                                                                                                 | 門禁の条件の 1 つが未達。レポートの判定根拠が古い                                                                             | 更新手順（新規 TC で置き換え／データ修正を運用手順として承認）を決定                                       | 所有者                               |
| P1-8 | 回帰は Chromium のみ。Access 越し E2E は未実行           | `playwright.config.ts` は `chromium` のみ。`L-11`・`07` §4 は Chrome/Edge の**手動確認**（2026-11-09、表示まで） | 対応ブラウザ（Chrome・Edge 最新 2 版）の保証が無い。公開経路の自動検証が止まっている                                          | 実機の手動確認を業務受入に同梱。Access 越し E2E はトークン権限の付与判断                                   | 所有者（トークン）／人間（手動確認） |

### P2（改善。リリースはブロックしない）

| #    | 項目                                                   | 根拠                                                                                                                                                                                                                              | 影響                                                                         | 次アクション                                              |
| ---- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| P2-1 | autofollow が DNS 失敗で 1.1% 停止                     | 保持期間内 成功 550 / 失敗 6。すべて `Could not resolve host: github.com`                                                                                                                                                         | Staging の追随が最大 10 分遅れる。fail-closed なので古い情報での配備はしない | 失敗の再試行 or 通知。まずは実測継続                      |
| P2-2 | ホスト起動直後に healthcheck が 1 回 NG                | 11-16 11:36:21 `ECONNREFUSED`（API 起動前）。`Persistent=true` で起動直後に発火                                                                                                                                                   | アラートノイズ（今回の `totalFailures` の主因）                              | `After=`／起動待ちの追加、または猶予の設定                |
| P2-3 | RTO 訓練が 2026-11-05 の 1 回のみ・timer 無し          | `rto-drill-20261105T104915Z.json`（40.847 秒）。全体 RTO は未測定                                                                                                                                                                 | 復旧時間の根拠が 13 日前の 1 点のみ                                          | 定期化（timer 追加）と、切替・Access を含む合同訓練       |
| P2-4 | `mirai-sf-reminders.timer` が `deploy/systemd/` に無い | repo の `deploy/systemd/` に timer が無く、実機のみ存在                                                                                                                                                                           | 再構築時に日次保守が再現できない                                             | repo に追加                                               |
| P2-5 | `OnFailure` が無い unit がある                         | Staging の backup / restore-drill / reminders、API / tunnel に `OnFailure` 無し                                                                                                                                                   | 失敗が `alerts.jsonl` に残らない（journal のみ）                             | `OnFailure` の横展開                                      |
| P2-6 | `StartLimitIntervalSec` の誤配置                       | `~/.config/systemd/user/mirai-sf-prod-api.service` の 18 行目（`[Service]` 内）。journal に `Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring`（11:13:59・11:25:26）。**repo の `deploy/systemd/` も同一** | 意図した「再起動回数無制限」が効かず systemd 既定が適用される                | `[Unit]` へ移動（repo と実機の両方）                      |
| P2-7 | CI の e2e ステップ名が実態と不一致                     | ステップ名「E2E（9シナリオ）」、実態は `playwright test`（8 spec + setup）                                                                                                                                                        | CI から件数が読めず、退行の件数比較ができない                                | ステップ名の修正、または `--reporter=list` 等で件数を残す |
| P2-8 | healthcheck の実行元が symlink 前提                    | `WorkingDirectory=%h/Projects/Software-Factory-Project`（`AGENTS.md` §7 の symlink）                                                                                                                                              | symlink が壊れると監視が止まる                                               | 常設パスを直接指定するか、symlink を監視対象に含める      |
| P2-9 | `pnpm test` / `test:e2e` をローカルで実行していない    | 本書の制約（他作業との競合回避）                                                                                                                                                                                                  | ローカルでの独立確認が無い（CI 依存）                                        | 競合の無い時間帯に 1 回実行して記録                       |

## 7. 未確認事項（実測していないこと）

| 項目                                 | 状態                               | 理由・代替根拠                                                                               |
| ------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| 本番の OTP ログイン成功と画面表示    | **未確認**                         | 人間の OTP 受信が必要（`42` §7、`24` §9）。`46` の 302 → Access は未認証時の確認のみ         |
| 本番の公開 URL                       | **未確認（本書では叩いていない）** | `07` §2-1 の「外部公開 URL は叩かない」に従った。`46` の実測（11:19、302 → Access）を引用    |
| `ALLOW_SELF_APPROVAL` の本番実値     | **未確認**                         | `prod.conf` を読んでいない（秘密を含むため）。コード上の本番既定は拒否、`44` は明示 0 で実測 |
| 本番 DB への書き込みを伴う業務フロー | **未確認**                         | 本書は SELECT のみ。`request=0` のため実データも無い                                         |
| 他ブラウザ・実機                     | **未確認**                         | `07` §4 の手動確認は 2026-11-09 の表示まで。E2E は Chromium のみ                             |
| 本番での故障注入・負荷試験           | **未実施**                         | `42` §7 の方針（本番では行わない）                                                           |
| 月間可用性・全体 RTO                 | **未測定**                         | journal 保持 3.9 日（P1-4）、RTO は部分実測のみ（§3-5）                                      |
| `bb7c2426` での E2E 件数             | **未確認**                         | 本書では `test:e2e` を実行していない。CI の e2e job success まで                             |

## 8. 作業中に気づいた矛盾・危険

1. **測定中に本番が変わった**（11:16 の認証変更、11:18 の配備。11:30 には main が `d9efe680` へ進行）。同じ日・同じ時間帯に別の作業が本番と main を変更している。**測定値は必ず時刻とセットで読む**必要がある（§2-1）。
2. **`deploy/systemd/` と実機の差**: 9 unit / 7 timer は一致するが、`mirai-sf-reminders.timer` は repo に無い。**本番用の reminders は存在しない**（P1-2・P2-4）。
3. **unit の設定不備が repo と実機の両方にある**（`StartLimitIntervalSec` の誤配置）。「repo が正」とは限らない（P2-6）。
4. **`/healthz` の `usersActive` は「有効な利用者数」**であり、`app_user` の全行数（3）と混同しやすい。`46` は「`app_user=3`（有効 2）」と正しく併記している。監視の判定は `usersActive` を使うため、**無効化の影響は `usersActive` の減少として現れる**。
5. **承認者 1 名 + 自己承認拒否**の組み合わせは、承認者が起票した依頼を**誰も承認できない**状態を作る（`44` で実測）。運用ルール（依頼は利用者アカウントで作る）を明文化しないと詰まる。
6. **品質工作台の不具合 7 件の `closed` 化は AI が実施した**（`47`）。門禁の承認（所有者のみ）とは別だが、状態更新の主体と承認者ルールの関係は `26` §3 の記録方針に沿って運用する必要がある。
7. 参照した `44`・`45`・`46`・`47` と更新後の `26`・`42` は、コミット `d9efe680`（2026-11-18、文書のみ）で追跡済みである。**未追跡なのは本書だけ**なので、同じ PR で追加すれば参照は閉じる。

## 9. 実測コマンド（再現用）

```bash
# Staging / 本番の稼働
curl -s http://127.0.0.1:8782/healthz ; curl -s http://127.0.0.1:8782/readyz
curl -s http://127.0.0.1:8783/healthz ; curl -s http://127.0.0.1:8783/readyz
systemctl --user show mirai-sf-api.service -p ActiveState,SubState,MainPID,NRestarts,Result,ExecMainStartTimestamp,WorkingDirectory
systemctl --user show mirai-sf-prod-api.service mirai-sf-prod-tunnel.service -p ActiveState,SubState,MainPID,NRestarts,Result,ExecMainStartTimestamp
readlink ~/.local/share/mirai-sf/current ; readlink ~/.local/share/mirai-sf-prod/current
systemctl --user list-timers --all 'mirai-sf*' --no-pager

# 監視・復旧
journalctl --user -u mirai-sf-prod-healthcheck.service -n 20 --no-pager -o short-iso
journalctl --user -u mirai-sf-autofollow.service -n 30 --no-pager -o short-iso
journalctl --user -u mirai-sf-prod-backup.service -n 12 --no-pager -o short-iso
systemctl --user show mirai-sf-prod-restore-drill.service -p Result -p ExecMainStatus

# RPO / RTO / オフサイト
pnpm -s ops:rpo-report --days 7
jq -c '.stages[]' ~/.local/state/mirai-sf-prod/rto-drill/rto-drill-20261105T104915Z.json
MIRAI_SF_ENV_FILE=$HOME/.config/mirai-sf/prod.conf pnpm -s ops:prod:offsite-status --count 2

# 利用者・DB（SELECT のみ）
pnpm -s ops:user-inventory --db mirai_sf_prod
psql -X -d mirai_sf_prod -h /var/run/postgresql -c "select count(*) from app_user where is_active;"

# 検証
pnpm typecheck ; pnpm lint
gh run list --branch main --limit 5
gh run view 43433387940 --json conclusion,headSha,jobs
```

## 10. 参照

- `26-release-status.md`（本番の状態・承認の正本。2026-11-18 11:22 更新。コミット `d9efe680`）
- `44-two-account-verification-20261118.md`（2 アカウント構成の隔離環境 17/17 PASS）、`45-auth-two-account-20261118.md`（認証 2 アカウント化）、`46-release-bb7c2426-20261118.md`（本日の配備）、`47-qa-update-20261118.md`（品質工作台の更新）
- `42-business-acceptance-plan-20261113.md`（業務受入計画）、`41-qa-update-20261113.md`（更新口の制約）、`36-release-readiness-20261113.md`（不具合・未被覆・E2E）
- `24-production-deploy-runbook.md`（配備手順・前提）、`07-slo-and-measurement.md`（SLO 目標と実測）、`docs/deployment.md`、`docs/limitations.md`（L-01/L-02/L-10/L-11）
- `deploy/systemd/*`（unit / timer の正本。ただし `mirai-sf-reminders.timer` は repo に無い）
