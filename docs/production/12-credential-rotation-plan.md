# 資格情報の棚卸しと rotation の実施計画

作成: 2026-11-05 JST。状態: **計画のみ。資格情報・設定ファイル・systemd は未変更**（実施は所有者の Y/N 後）。

`08-credential-hygiene.md`（所見・応急処置・一般手順）を、実施できる単位に落とした計画である。ADR §8.2 Q4（設定変更は都度 Y/N）に従う。**値は本書・PR・チャット・ログに書かない。** 本書の変数名は、既存文書（ADR §4、runbook）とコード（`src/`・`scripts/`・`deploy/systemd/`）から拾ったもので、設定ファイル（`*.conf` / `*.env` / `local.json`）の中身は読んでいない。

## 1. 棚卸しの対象（コードと文書から分かる範囲）

| #   | 種類                       | 変数名・認証の形                                                                | 用途                                                                             | 依存する unit / 入口                                                                            | 保管場所（ファイル名のみ）                                   |
| --- | -------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| C1  | アプリのセッション署名     | `SESSION_SECRET`                                                                | セッション Cookie の署名（未設定だと起動ごとに乱数）                             | `mirai-sf-prod-api` / `mirai-sf-api`・`mirai-sf-worker`（Staging）                              | `prod.conf` / `preview.conf`                                 |
| C2  | origin 共有秘密            | `ORIGIN_SHARED_SECRET`（`REQUIRE_ORIGIN_SECRET=1` と組）                        | Worker/Tunnel 経由以外からの直接到達を拒否                                       | `mirai-sf-prod-api`。送る側（Cloudflare Worker の設定）と**同時に**変える必要あり（runbook §2） | `prod.conf`・Cloudflare Worker 側                            |
| C3  | DB 接続                    | `DATABASE_URL` / `MIGRATION_DATABASE_URL`（`PGPASSWORD` は派生）                | API・migration・backup・restore-drill・`add-user`                                | prod-api・prod-backup・prod-restore-drill（`MIRAI_SF_ENV_FILE` 経由）                           | `prod.conf` / `preview.conf`。Unix socket ならパスワード無し |
| C4  | Access JWT 検証の設定      | `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`                                             | Access JWT の発行元・audience の照合（**秘密ではないが変更で全員ログイン不可**） | prod-api                                                                                        | `prod.conf`                                                  |
| C5  | Access サービストークン ID | `ACCESS_SERVICE_TOKEN_IDS`（ID のみ）／ `ACCESS_CLIENT_SECRET`（smoke 用）      | 機械アクセスの許可。現在の本番は 0 件（L-11）                                    | prod-api・`scripts/smoke.ts`                                                                    | `prod.conf`・運用者の手元                                    |
| C6  | GitHub（アプリ）           | `GITHUB_TOKEN`                                                                  | 旧来の Issue 作成（Staging）。本番では使わない（ADR §4.3）                       | `mirai-sf-api`（Staging）。autofollow は `UnsetEnvironment` で除外済み                          | `preview.conf`                                               |
| C7  | GitHub（開発ライン）       | `DEVLINE_GITHUB_TOKEN`                                                          | 実 runner の Issue 作成・PR merge                                                | `mirai-sf-worker`・API（`DEVLINE_SECRETS_FILE` から）                                           | `devline-secrets.env`                                        |
| C8  | AI API                     | `ANTHROPIC_API_KEY`                                                             | 実 AI runner の推論                                                              | `mirai-sf-worker` のみ                                                                          | `devline-secrets.env`                                        |
| C9  | GitHub（ホスト）           | `gh` の OAuth                                                                   | autofollow の fetch・PR 作成・CI 照合（exact-main ゲート）                       | `mirai-sf-autofollow`、`prod-release.sh` / `release.sh` の CI 照合                              | `~/.config/gh/hosts.yml`                                     |
| C10 | Cloudflare（R2 送信）      | wrangler の OAuth（現行の唯一の経路）。`MIRAI_SF_R2_API_TOKEN` は下記の注を参照 | dump と manifest の R2 送信・読み戻し、offsite-drill                             | `mirai-sf-prod-backup`・`pnpm ops:prod:offsite-drill`                                           | wrangler のログイン情報（人のアカウント）                    |
| C11 | Cloudflare API（運用）     | `CLOUDFLARE_API_TOKEN`                                                          | Tunnel/DNS/Access の運用操作。`offsite-r2.mjs` は明示時以外これを外す            | 運用者の手作業                                                                                  | 運用者の手元（ADR §4.4）。user manager 環境に残存（08 §1）   |
| C12 | Tunnel                     | Tunnel 資格情報（JSON）                                                         | `cloudflared` の接続                                                             | `mirai-sf-prod-tunnel`                                                                          | `~/.cloudflared/<tunnel>.json`（0400）                       |
| C13 | SMTP                       | `SMTP_PASS`                                                                     | メール送信。本番は `MAIL_MODE=off`                                               | prod-api（有効化した場合のみ）                                                                  | `prod.conf`                                                  |
| C14 | 初期管理者                 | `SEED_ADMIN_PASSWORD`                                                           | seed の初期管理者（本番は空・使わない。ADR §4.1）                                | seed・smoke                                                                                     | `local.json` / `preview.conf`                                |

- user manager の環境（`systemctl --user show-environment`）には、GitHub 系と `CLOUDFLARE_API_TOKEN` に相当する変数が残っている（08 §1）。値は一度セッションログに現れたため、C6・C11 の rotation を優先する。`scripts/setup-preview.mjs` は `gh auth token` を `GITHUB_TOKEN` に書く（ADR §4.3）ため、環境に残る GitHub 系の値が C9 と同じものかは未確認であり、C9 も同時に対象にする。
- **C10 の注（専用トークンは現行コードでは未対応）**: `scripts/ops/offsite-r2.mjs`（73〜76 行）と `scripts/ops/offsite-drill.mjs`（50〜53 行）は、`MIRAI_SF_R2_API_TOKEN` が**あるかどうかだけ**を見て、無ければ継承した `CLOUDFLARE_API_TOKEN` を外す。`MIRAI_SF_R2_API_TOKEN` の値を `CLOUDFLARE_API_TOKEN` として wrangler に渡す処理は無い。したがって R2 バケット限定の専用トークンを用意しても、現行コードでは使われない（`MIRAI_SF_R2_API_TOKEN` を設定すると、環境に残る別用途の `CLOUDFLARE_API_TOKEN` がそのまま wrangler に渡るおそれがある）。専用トークンを採用するには、両スクリプトの改修（別 PR）が前提になる。

## 2. 棚卸しの手順（値を表示しない）

1. 確認プログラムは**標準出力・標準エラーを内部で捕捉し、変数名と「設定あり/なし」だけを出す**。生の `show-environment`・`show -p Environment`・`cat` / `grep` の行出力は使わない（08 §3-4）。
2. unit ごとに「`EnvironmentFile` のファイル名」「`Environment=` の変数名」「`UnsetEnvironment`」を `deploy/systemd/` と `~/.config/systemd/user/` から変数名だけ抜き、§1 の表と照合する。
3. 設定ファイルは**キー名の一覧だけ**を得る（値部分を捨てる処理をプログラム内で行う）。権限（0600/0400）と所有者も記録する。
4. 表に無い変数名が見つかったら、用途と依存 unit を特定するまで追加しない（推測で埋めない）。
5. 結果は本書 §6 に「日時・対象・変数名・設定有無・権限」だけを追記する。

## 3. rotation の共通手順

各資格情報で「新規発行 → 配置 → 機能検証 → 旧の失効 → 再検証」を守る。旧値の失効は、新値での検証が通るまで行わない。

1. **事前**: 対象 unit と機能の確認方法を §4 から決める。切替前の設定ファイルを 0600 で退避（同ディレクトリ・日付付き）。退避後に 0600・所有者のみであることを確認する。本番は直前に `/healthz` と最新バックアップ成功を確認。
2. **新規発行**: 最小権限・対象限定・期限付き（GitHub fine-grained PAT、Cloudflare は対象アカウント・必要スコープのみ）。発行画面での操作は所有者（UI 作業）。
3. **配置**: 0600 ファイルへ所有者が直接書く（チャット・引数・環境変数の一覧を経由しない）。`systemctl --user daemon-reload` → 該当 unit を再起動。
4. **機能検証**: §4 の確認を実測。失敗したら退避ファイルへ戻し再起動（ロールバック）。**旧資格情報へのロールバックは旧値を失効する前だけ**できる。
5. **旧の失効**: 発行元（GitHub / Cloudflare）で失効。これ以降、旧値へは戻れない（失敗時は新しい値を発行し直す）。DB パスワード（C3）は手順 3 の `ALTER ROLE` の時点で旧値が無効になるため、この手順は無い（§4 の例外）。
6. **再検証**: §4 をもう一度。失効後に失敗するなら、旧値に依存する経路が残っている（棚卸し漏れ）。
7. **退避物の削除**: 再検証が成功したら、手順 1 の退避ファイル（旧値を含む）を削除する。削除前に対象が退避ファイルであること（パス・0600・所有者）を確かめ、`shred -u`（使えない場合は `rm`）で消す。中身は表示しない。ファイルシステム上の残存は完全には消せないため、旧値は失効済みであることを前提にする。
8. **記録**: 日時・対象 ID（値ではない）・結果・退避物の削除を §6 に追記。user manager 環境に残る同名変数は `systemctl --user unset-environment` で外す（別の Y/N）。

## 4. 資格情報ごとの計画（所要は作業時間の目安。実測ではない）

ロールバック列は**旧値の失効前のみ**有効（§3-4・5）。失効後は新しい値を発行し直す。**例外は C3**: `ALTER ROLE ... PASSWORD` は新値の設定と同時に旧値を無効にするため、旧値へのロールバックは無い。C3 の復旧は、DB owner（またはスーパーユーザー）が明示的にパスワードを再設定し、設定ファイルを合わせることで行う。

| 対象                  | 所要  | 切替窓・影響                                                                                                                                                                           | 機能検証                                                                         | ロールバック                                                              |
| --------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| C9                    | 15 分 | autofollow の次回実行まで。業務影響なし                                                                                                                                                | `gh auth status`、autofollow の 1 回実行、`prod-release.sh --dry-run` の CI 照合 | 旧ログインに戻す                                                          |
| C6・C11（環境の残存） | 20 分 | user manager 環境から外すだけ。依存 unit を先に確認（08 §3-3）                                                                                                                         | autofollow・backup・healthcheck の次回成功                                       | `set-environment` で戻す                                                  |
| C10                   | 20 分 | backup の 55 分間隔の合間。失敗すると backup unit が failed（exit 4）                                                                                                                  | backup 1 回 + `ops:prod:offsite-drill`（取得・SHA-256・復元）                    | 旧ログインに戻す                                                          |
| C7・C8                | 30 分 | Staging の worker のみ。job が無い時間帯                                                                                                                                               | worker 起動・`/readyz`、fake でない runner の設定読み込み確認                    | 退避した `devline-secrets.env`                                            |
| C1                    | 10 分 | **全利用者のセッションが失効し再ログインが要る**。業務時間外                                                                                                                           | prod-api 再起動後の `/healthz`、所有者の Access ログイン → コンソール表示        | 退避した `prod.conf`                                                      |
| C2                    | 30 分 | Cloudflare 側とアプリ側の**同時切替**。ずれると `/healthz`・`/readyz` 以外は 403。この 2 つは origin secret 検証の例外（`src/api/app.ts`）なので**監視上は正常に見える**（監視の盲点） | 公開 URL で Access ログイン後の画面表示（health では代用不可。03 §5.2）          | 両側を旧値へ                                                              |
| C3                    | 30 分 | DB ロールのパスワード変更。旧値は変更と同時に無効。Unix socket 接続なら対象外                                                                                                          | `/healthz` の db ok、backup 1 回、restore-drill 1 回                             | 旧値には戻せない。DB owner が明示的に再設定し、設定ファイルを合わせて復旧 |
| C12                   | 30 分 | Tunnel の再作成・資格情報差替えで公開 URL が一時停止                                                                                                                                   | 公開 URL の 302 → Access、ログイン後の画面                                       | 旧資格情報ファイル（0400）                                                |
| C13・C14              | －    | 本番では未使用（`MAIL_MODE=off`、seed 管理者なし）。有効化時に計画する                                                                                                                 | －                                                                               | －                                                                        |

## 5. 所有者の Y/N 判断（実施前に 1 項目ずつ）

1. §2 の棚卸し（読取りのみ、変数名と有無だけ出力）を AI が実施してよいか Y/N
2. C9（gh OAuth）を再ログインで更新するか Y/N（ブラウザ操作は所有者）
3. user manager 環境から GitHub 系・`CLOUDFLARE_API_TOKEN` を外すか Y/N（外す前に依存 unit を提示）
4. 外した旧トークン（C6・C11）を発行元で失効するか Y/N
5. C10（wrangler OAuth）を再ログインで更新するか Y/N。R2 バケット限定の専用トークンへの切替は**現行コードでは未対応**（§1 の注）のため、ここでは選択肢にしない。採用するなら、先に `offsite-r2.mjs`・`offsite-drill.mjs` の改修 PR を作るか Y/N を別に問う
6. C7・C8（Staging の開発ライン）を rotation するか Y/N
7. C1（本番の再ログイン発生）を実施するか Y/N と時間帯
8. C2（Cloudflare 側と同時切替）を実施するか Y/N と時間帯
9. C3・C12 は漏えいの所見が無いため今回は見送るか Y/N
10. rotation の定期周期（番号: 1) 90 日 2) 180 日 3) 漏えい時のみ）

## 6. 実施記録

（未実施。実施したら日時・対象・結果のみを追記する。値は書かない）
