# 本番（Production）運用手順

対象: 本番環境の構築・リリース・バックアップ・復元・ロールバック・監視。
前提: `docs/production/00-adr.md`（案A）と `01-staging-acceptance.md`。**公開（DNS / Access）は最後**に行う。

> 本書は手順書であり、実施の許可ではない。公開ホスト名の作成と本番DBの作成は、
> ADR §8 の決定（Y/N）を記録してから行う。

## 1. 構成（Staging との分離）

| 項目         | Staging（現行）                   | 本番（この手順）                                   |
| ------------ | --------------------------------- | -------------------------------------------------- |
| ホーム       | `~/.local/share/mirai-sf`         | `~/.local/share/mirai-sf-prod`                     |
| 設定         | `~/.config/mirai-sf/preview.conf` | `~/.config/mirai-sf/prod.conf`（0600）             |
| DB           | `mirai_sf`                        | `mirai_sf_prod`                                    |
| 待受         | `127.0.0.1:8782`                  | `127.0.0.1:8783`                                   |
| systemd      | `mirai-sf-api` ほか               | `mirai-sf-prod-api` / `-backup` / `-restore-drill` |
| healthz      | `http://127.0.0.1:8782/healthz`   | `http://127.0.0.1:8783/healthz`                    |
| worker       | 動かす（Sandbox のみ）            | **動かさない**（ADR §8-10）                        |
| 公開ホスト名 | `sf.mirai-dx-platform.com`        | `sf-prod.mirai-dx-platform.com`（決定後）          |

本番の値は `prod.conf` だけに置く。Staging の `preview.conf` と共用しない。

## 2. 事前準備（1回だけ）

```bash
# 1. 本番DB（additive migration のみ。破壊的操作はしない）
createdb -O "$USER" mirai_sf_prod
DATABASE_URL='postgresql:///mirai_sf_prod?host=/var/run/postgresql' \
MIGRATION_DATABASE_URL='postgresql:///mirai_sf_prod?host=/var/run/postgresql' \
  pnpm exec tsx scripts/db.ts migrate
# seed は本番では実行しない（見本データを入れない）。管理者ユーザーだけを登録する。

# 2. 設定（0600。値をシェルの履歴・ログへ出さない）
install -m 600 /dev/null ~/.config/mirai-sf/prod.conf
$EDITOR ~/.config/mirai-sf/prod.conf
```

`prod.conf` の必須項目（例。値はここに書かない）:

```
NODE_ENV=production
APP_ENV=production
PORT=8783
HOST=127.0.0.1
APP_BASE_URL=https://sf-prod.mirai-dx-platform.com
DATABASE_URL=postgresql:///mirai_sf_prod?host=/var/run/postgresql
SESSION_SECRET=<32 バイト以上の乱数>
ORIGIN_SHARED_SECRET=<Cloudflare Worker 経由の確認に使う値>
REQUIRE_ORIGIN_SECRET=1
COOKIE_SECURE=1
TRUST_PROXY=1
AUTH_MODE=access
ACCESS_ALLOWED_DOMAIN=mirai-const.co.jp
ACCESS_ALLOWED_EMAILS=<公開承認者のメール（ドメインで足りない場合）>
ALLOW_SELF_APPROVAL=0
ALLOW_IMPORT=0
MAIL_MODE=off
SEED_ADMIN_EMAIL=<管理者メール>
SEED_ADMIN_PASSWORD=<初期パスワード>
APP_VERSION=0.1.0
GITHUB_REPO=Kensan196948G/Software-Factory
# オフサイト（ADR §8-7: Cloudflare R2）。dump と manifest を非公開バケットへ送る
MIRAI_SF_OFFSITE_CMD=scripts/ops/offsite-r2.mjs
MIRAI_SF_R2_BUCKET=mirai-sf-prod-backups
MIRAI_SF_R2_PREFIX=mirai_sf_prod
```

- 本番の決定は `docs/production/00-adr.md` §8.1（2026-11-03）にある。**公開の直前に「公開前に再確認」の項目を 1 行で確認する**。
- `AUTH_MODE=access` を使う場合、`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` を設定すると JWT 検証が必須になる（`docs/deployment.md` §3-1）。**公開前に必ず設定する**。
- `ALLOW_SELF_APPROVAL=0` は本番の統制（ERR-105）。承認者を別ユーザーで用意する。
- `ALLOW_IMPORT=0`（全件置換の取込を本番で許可しない）。必要になった時だけ一時的に許可し、監査に残す。
- `MIRAI_SF_OFFSITE_CMD` は `backup.sh` の送信フック。未設定ならローカルのみ（RPO 1 時間の決定に反するため、本番では必ず設定する）。

## 3. リリース

```bash
cd /mnt/storage/Software-Factory/Software-Factory
git switch main && git pull --ff-only
SHA=$(git rev-parse HEAD)

# 1. 計画の確認（何も変えない）
pnpm ops:prod:release --dry-run "$SHA"

# 2. 展開・ビルド・事前バックアップ・migration・current 作成（再起動しない）
pnpm ops:prod:release --no-restart "$SHA"

# 3. unit の配置（初回だけ）
cp deploy/systemd/mirai-sf-prod-api.service deploy/systemd/mirai-sf-prod-backup.service \
   deploy/systemd/mirai-sf-prod-backup.timer deploy/systemd/mirai-sf-prod-restore-drill.service \
   deploy/systemd/mirai-sf-prod-restore-drill.timer ~/.config/systemd/user/
systemctl --user daemon-reload

# 4. 切替（current を指す unit で再起動し、healthz の commit を確認）
systemctl --user enable --now mirai-sf-prod-api.service
systemctl --user restart mirai-sf-prod-api.service
curl -fsS http://127.0.0.1:8783/healthz

# 5. 定期ジョブ
systemctl --user enable --now mirai-sf-prod-backup.timer mirai-sf-prod-restore-drill.timer
systemctl --user start mirai-sf-prod-backup.service
systemctl --user start mirai-sf-prod-restore-drill.service
journalctl --user -u mirai-sf-prod-backup -u mirai-sf-prod-restore-drill -n 40 --no-pager
```

2 回目以降は `pnpm ops:prod:release "$SHA"` だけでよい。`/healthz` が失敗すると**前のリリースへ自動で戻る**（DB は戻さない）。

## 4. 受入チェックリスト（本番切替後）

| #   | 確認                                       | 期待                                                        |
| --- | ------------------------------------------ | ----------------------------------------------------------- |
| 1   | `GET /healthz`                             | 200 / `status=ok` / `db.ok=true` / `environment=production` |
| 2   | `commit`                                   | リリースした SHA と一致                                     |
| 3   | `GET /`（未認証）                          | Access のログインへ 302（公開後）                           |
| 4   | `Cf-Access-Authenticated-User-Email` 偽装  | `/api/auth/me` が 401（JWT 検証が有効なとき）               |
| 5   | 受付 1 件の登録 → 承認 → 注文書YAML        | 画面で完了し、監査ログに残る                                |
| 6   | 自己承認                                   | 依頼者と同一ユーザーの承認が ERR-105 で拒否される           |
| 7   | `pnpm ops:prod:backup`                     | dump と manifest が作られる                                 |
| 8   | `pnpm ops:prod:restore-drill`              | 復元・件数照合・ハッシュ連鎖照合・一時DB削除が成功          |
| 9   | `journalctl --user -u mirai-sf-prod-api`   | 5xx / ERROR が出ていない                                    |
| 10  | `pnpm ops:prod:rollback --dry-run <前SHA>` | 戻し先が表示される                                          |

## 5. バックアップ・復元・保持

- **毎時**: `mirai-sf-prod-backup.timer`（毎時 :05。RPO 1 時間 = ADR §8-6 の決定）が `pg_dump -Fc` + 同一スナップショットの manifest を `~/.local/state/mirai-sf-prod/backups/` へ出す（0700/0600）。
- 週次: `mirai-sf-prod-restore-drill.timer`（日曜 04:30）が一時DBへ復元して件数と監査ハッシュ連鎖を照合し、必ず消す。
- **オフサイト（Cloudflare R2、ADR §8-7 の決定）**: `prod.conf` の `MIRAI_SF_OFFSITE_CMD=scripts/ops/offsite-r2.mjs` で、毎時の dump と manifest を非公開バケット `mirai-sf-prod-backups`（APAC）へ送り、置いた実体を読み戻してバイト数の一致を確かめる。送信に失敗すると backup ユニットは **failed（終了コード 4）** になり、ローカルの dump は残る。認証は wrangler のログイン（OAuth）に依存する。R2 の S3 アクセスキーを用意できたら `rclone copyto` へ差し替える（`MIRAI_SF_OFFSITE_CMD` を差し替えるだけ）。
- 保持: DB の監査行は削除しない（追記のみ）。ファイルの世代管理は `MIRAI_SF_BACKUP_RETENTION_DAYS`（既定14日。毎時だと最大 336 世代 = 約 60 MB/年）。

## 6. ロールバック

```bash
pnpm ops:prod:rollback --dry-run <戻し先SHA>
pnpm ops:prod:rollback <戻し先SHA>
```

- DB は戻さない（migration は additive のみ）。戻す必要がある場合は「別DBへ復元 → 検証 → 切替」。
- 直前のリリースが残っていることを確認する（自動削除はしない）。

## 7. 監視

- `mirai-sf-healthcheck`（5分間隔）を本番にも向ける場合は、`MIRAI_SF_HEALTH_URL` を `8783` にした別 timer を作る（Staging と混在させない）。
- 失敗は `systemctl --user --failed` と journal で可視化する。外部通知は未実装（Access サービストークン待ち）。

## 8. 公開（最後・人の承認が必要）

1. ADR §8 の決定を `docs/devline/assessment/source-conflicts.md` に記録する。
2. Cloudflare Zero Trust に本番用 Access アプリ（`sf-prod.mirai-dx-platform.com`、session 12h、OTP、`email_domain=mirai-const.co.jp`）を作成する。
3. Tunnel の ingress に `sf-prod.mirai-dx-platform.com → http://127.0.0.1:8783` を追加し、DNS を CNAME で張る。
4. 公開後、受入チェックリスト（§4）を再実行する。
5. 切り戻し: ingress と DNS を戻し、`systemctl --user stop mirai-sf-prod-api`。

**公開は不可逆に近い**ため、手順 1〜3 の前に Y/N の確認を取る。

## 9. 障害時の一次対応

| 症状                     | 一次対応                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `/healthz` が 5xx / 停止 | `systemctl --user status mirai-sf-prod-api`、journal を確認。直近の正常リリースへ rollback |
| DB 接続エラー            | PostgreSQL の起動・接続数・ディスクを確認。復元は「別DBへ」                                |
| 認証できない             | `AUTH_MODE` と `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`、Access アプリの AUD を確認             |
| リリース後に画面が古い   | `dist` の版（`asset-version`）とブラウザのキャッシュを確認                                 |
| バックアップが失敗       | `journalctl --user -u mirai-sf-prod-backup`、空DBでは失敗する（仕様）                      |
