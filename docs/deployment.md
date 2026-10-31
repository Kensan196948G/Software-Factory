# デプロイ（Cloudflare Preview）と復旧

対象は**検証環境（Preview）のみ**。Production正式環境は本Goalの対象外。

## 1. 構成（実測・2026-10-28）

```
Browser
  → https://sf.mirai-dx-platform.com（Cloudflare プロキシ）
  → Cloudflare Access（ワンタイムパスワード、12時間）
  → Cloudflare Tunnel `mirai-sf`（91280c04-3009-4c7f-a739-9e37f0808e6e）
  → http://127.0.0.1:8782（Node API + SPA）
  → ローカルPostgreSQL 16（127.0.0.1:5432 / mirai_sf）
```

| 項目            | 実測値                                                                            |
| --------------- | --------------------------------------------------------------------------------- |
| 公開URL         | `https://sf.mirai-dx-platform.com`（Access 保護。未認証はログインへ302）          |
| DNS             | `sf` CNAME → `91280c04-….cfargotunnel.com`（proxied）                             |
| Tunnel          | `mirai-sf` / 4コネクション登録（nrt01 / nrt16）                                   |
| サービス        | systemd user: `mirai-sf-api.service`（127.0.0.1:8782）, `mirai-sf-tunnel.service` |
| 設定            | `~/.config/mirai-sf/preview.conf`（0600, EnvironmentFile）                        |
| Access アプリ   | `Mirai Software Factory 受付ステーション`（session 12h, OTP）                     |
| Access ポリシー | `email_domain = mirai-const.co.jp`（allow）＋管理者アカウント（allow）            |
| DB              | `mirai_sf`（19部署・118道具・見本9件）                                            |
| Health          | `GET /healthz` = `status=ok` / `db.ok=true`（tunnel 経由）                        |

ローカルPostgreSQLはインターネットへ公開しない。アプリは 127.0.0.1 のみにバインドし、Tunnel からのみ到達する。

## 2. 事前確認（Deployment Gate）

- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build`
- [x] `pnpm db:verify` / `node scripts/secret-scan.mjs`
- [x] migration が空DBから再実行できる
- [x] Critical/High の既知問題なし（下記の制限を除く）
- [x] Rollback手順を確認

## 3. 手順（再現用）

```bash
# 1. Preview DB
createdb -O "$USER" mirai_sf
DATABASE_URL='postgresql:///mirai_sf?host=/var/run/postgresql' \
MIGRATION_DATABASE_URL='postgresql:///mirai_sf?host=/var/run/postgresql' \
SEED_ADMIN_EMAIL=<管理者メール> SEED_ADMIN_PASSWORD=... pnpm exec tsx scripts/db.ts migrate
# seed も同様に実行

# 2. ビルド
pnpm build

# 3. 設定（0600）
node scripts/setup-preview.mjs     # ~/.config/mirai-sf/preview.conf（APP_ENV=staging を含む。既存の conf には手で追記）

# 4. systemd（user）
systemctl --user daemon-reload
systemctl --user enable --now mirai-sf-api.service mirai-sf-tunnel.service

# 5. Tunnel（初回のみ）
cloudflared tunnel create mirai-sf
cloudflared tunnel route dns --overwrite-dns mirai-sf sf.mirai-dx-platform.com

# 6. Access（Cloudflare Zero Trust）
#    Application: self_hosted / sf.mirai-dx-platform.com / session 12h / One-time PIN
#    Policy: email_domain = mirai-const.co.jp（allow）
```

## 4. デプロイ後の確認（実測済み／残り）

| #   | 確認                            | 結果                                                                              |
| --- | ------------------------------- | --------------------------------------------------------------------------------- |
| 1   | `/healthz` が ok / db ok        | ✅（tunnel 経由）                                                                 |
| 2   | 未認証で Access のログインへ302 | ✅                                                                                |
| 3   | トップページ表示（CSPエラー0）  | ローカル本番ビルドで確認済み。**Access ログイン後の実画面は人間の確認が必要**     |
| 4   | 登録→承認→注文書                | ✅（E2E 10/10、本番ビルド＋dev DB）。Preview DB `mirai_sf` は認証情報不足で未実行 |
| 5   | API（home/catalog/export）      | ✅（ローカル本番ビルド・E2E）                                                     |
| 6   | DB Read/Write                   | ✅（E2E と Issue 作成で実測）                                                     |
| 7   | Runtime（5xx/ERROR）            | `journalctl --user -u mirai-sf-api` で確認                                        |
| 8   | GitHub Issue 自動作成           | ✅（Issue #2）                                                                    |

2026-10-28 の再デプロイ: `pnpm build` → `systemctl --user restart mirai-sf-api.service` → `/healthz` 200・`/console.js` が新版（メール送信BOXを含む）・公開URLは Access のログインへ302 を確認。

Access のワンタイムパスワードは受信メールが必要なため、自動E2Eでは実施していない。**人間の最終確認**: ブラウザで `https://sf.mirai-dx-platform.com` を開き、`@mirai-const.co.jp` のメールアドレスでコードを受け取り、ログイン → ホーム → 依頼詳細 → 承認 → 注文書 を確認する。

## 5. ローカルDNSについて

このホストのシステムDNS（192.168.245.11）が新規ホスト名を解決しない間は、`/etc/hosts` に次の1行を入れて確認した（2026-10-28時点・暫定）。

```
104.21.57.65 sf.mirai-dx-platform.com
```

DNS伝播後は不要。ブラウザで名前解決できない場合は削除・更新する。

## 6. 復旧 / Rollback

| 対象     | 方法                                                                                |
| -------- | ----------------------------------------------------------------------------------- |
| Node API | `git checkout <直前のSHA>` → `pnpm build` → `systemctl --user restart mirai-sf-api` |
| Tunnel   | `systemctl --user restart mirai-sf-tunnel`（設定変更前はバックアップ）              |
| DB       | migrationはadditive。障害時は `pg_restore` でバックアップから復元                   |
| Access   | アプリ/ポリシーを元に戻す（変更履歴を記録）                                         |
| 全停止   | `systemctl --user disable --now mirai-sf-api mirai-sf-tunnel`                       |

**破壊的DB操作は行わない。** 復元は「別DBへ復元 → 検証 → 切替」を基本とする。

§9 の固定リリースへ移行した後の Node API は、`scripts/ops/rollback.sh <SHA>` で切り替える。

## 7. 監視

- `/healthz` の定期確認（Access 配下のため、外形監視には Access の bypass か サービストークンが必要）
- systemd `Restart=always`
- 監査ログのハッシュ連鎖（`/api/audit-logs`）
- ログ: `journalctl --user -u mirai-sf-api`（個人情報は出力しない）

### 7-1. 日次の滞留通知・下書きTTL（登録済み）

承認待ち・公開承認待ちのまま N 日止まった依頼へ、1日1回だけ催促メールを送る。

```bash
# 手動（1回だけ）
REMINDER_DAYS=3 node scripts/local-run.mjs tsx scripts/reminders.ts

# systemd user timer の例（毎朝 8:30）
# ~/.config/systemd/user/mirai-sf-reminders.service
#   [Service]
#   Type=oneshot
#   WorkingDirectory=/mnt/storage/Software-Factory/Software-Factory
#   ExecStart=/usr/bin/env REMINDER_DAYS=3 /usr/bin/node scripts/local-run.mjs tsx scripts/reminders.ts
# ~/.config/systemd/user/mirai-sf-reminders.timer
#   [Timer]
#   OnCalendar=*-*-* 08:30:00
#   Persistent=true
#   [Install]
#   WantedBy=timers.target
systemctl --user enable --now mirai-sf-reminders.timer
```

同じ依頼・同じ日は unique 制約で1通に落ちるため、何度実行しても重複しない。
下書きの保存期限（`DRAFT_TTL_DAYS`、既定30日）切れの削除と、期限が来たメールの自動再送も同じジョブで行う。

2026-10-28 に `mirai-sf-reminders.timer`（毎日 08:30 JST）を登録し、初回実行で催促メール1通（`status='sent'`）を実測。

### 7-2. 監査ログのアーカイブ

```bash
pnpm audit:archive    # 差分を ~/.local/state/mirai-sf/audit/audit-YYYY-MM-DD.jsonl.gz へ出力（既定365日で世代管理）
```

DBの監査行は追記のみで消さない（アーカイブは外部コピー）。実行前後でハッシュ連鎖を検証する。

### 7-3. CI（GitHub Actions）

- `quality`: typecheck / lint / unit / migration（空DB・冪等）/ seed / db:verify / integration / build / secret scan
- `e2e`: Postgres サービス＋ビルド＋Playwright（`quality` 成功後に実行）

## 8. 既知の制約

- Access のサービストークン発行は、現在のAPIトークンに `access-service-token.write` が無いため未実施。外形監視を自動化する場合はトークン権限の追加が必要。
- CI は `.github/workflows/` のポリシーゲートにより未適用（`docs/patches/README.md`）。
- ローカルホスト停止時は Preview も停止する（仕様）。

## 9. Staging の運用（バックアップ・固定リリース）

`scripts/ops/` と `deploy/systemd/` の雛形で、Preview を commit に固定して運用する。

| 操作           | コマンド                              | 内容                                                                                    |
| -------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| バックアップ   | `pnpm ops:backup`                     | `pg_dump -Fc` を `~/.local/state/mirai-sf/backups/` へ（0700/0600）。既定14日で世代管理 |
| 復元ドリル     | `pnpm ops:restore-drill`              | 最新を一時DB `mirai_sf_drill_<ts>` へ復元し、件数とハッシュ連鎖を検証して一時DBを消す   |
| リリース       | `pnpm ops:release [--dry-run] <SHA>`  | main に含まれる commit だけを展開し、切替と `/healthz` の commit 確認まで行う           |
| ロールバック   | `pnpm ops:rollback [--dry-run] <SHA>` | 展開済みのリリースへ切替（DB は戻さない）                                               |
| 日次保守       | `pnpm ops:reminders`                  | preview.conf の DB に対して滞留通知・再送・下書きTTLを実行                              |
| 監査アーカイブ | `pnpm ops:audit:archive`              | 同じDBに対して §7-2 を実行                                                              |
| DB 検証        | `pnpm ops:db:verify`                  | 同じDBに対して `db:verify` を実行                                                       |

### 9-1. 設計上の決まり

- `scripts/ops/with-env.mjs` が `preview.conf` を環境変数にして実行する。値は表示しない。開発用の `MIRAI_SF_CONFIG_FILE` や別DBを指す `MIGRATION_DATABASE_URL` / `TEST_*` は子プロセスへ渡さない。
- `COMMIT_SHA` は `preview.conf` ではなく各リリースの `release.env` に置く。unit が `preview.conf` の後に読むので、`current` を切り替えるだけで `/healthz` の commit も切り替わる。
- バックアップには同じスナップショットで取った件数と監査ログ末尾のハッシュ（`*.manifest.tsv`）を添える。稼働中のDBと比べると必ずずれるので、ドリルはこの manifest と照合する。
- 世代管理とドリルの対象は `<DB>-<YYYYMMDD>T<HHMMSS>Z.dump` の名前だけ。手動で取った dump には触らない。
- PostgreSQL クライアントは `/usr/lib/postgresql/16/bin` を優先する（`MIRAI_SF_PG_BIN_DIR` で変更可）。17 以上の `pg_dump` は restore 時に `transaction_timeout` の警告を出す。
- Node は unit の `PATH` と `MIRAI_SF_NODE_BIN_DIR` で 22 を指定する。systemd user の既定 `PATH` では `/usr/bin/node`（v20）になり、`engines` を満たさない。
- `MAIL_OUTBOX_DIR` は `current` の外に置く（作業ディレクトリ基準のままだとリリースごとに分かれる）。
- 移行後の `dist/` と `node_modules` はリリースごとに持つ。古いリリースの自動削除はしない。

### 9-2. migration の扱い

`release.sh` は未適用の migration を調べ、破壊的な可能性がある文（`DROP TABLE` / `DROP COLUMN` / `TRUNCATE` / `DELETE FROM` / 型変更 / 名前変更 など）があれば、DB にも `current` にも触らず終了コード 3 で止まる。文字列照合による補助であり、レビューの代わりにはならない。既存の作法である `drop constraint` / `drop trigger` の作り直しは対象外。

事前バックアップは空のDBでは失敗する（`audit_log` が必要）。新規構築は §3 の手順で migrate と seed を済ませてから行う。

### 9-3. 固定リリースへの初回切替

稼働中の unit は git の作業ディレクトリを見ている。`current` がない状態で unit を入れ替えないよう、この順で行う。PR がマージされた後の main の commit を使う。

```bash
# 0. 本体のチェックアウトを main の最新にする（release.sh をここから実行するため）
cd /mnt/storage/Software-Factory/Software-Factory
git switch main && git pull --ff-only
SHA=$(git rev-parse HEAD)

# 1. 計画の確認（何も変更しない）
pnpm ops:release --dry-run "$SHA"

# 2. 展開・ビルド・事前バックアップ・migration・current 作成（再起動はしない）
pnpm ops:release --no-restart "$SHA"

# 3. 現在の unit を退避して雛形を入れる
mkdir -p ~/.config/mirai-sf/unit-backup
cp -p ~/.config/systemd/user/mirai-sf-api.service ~/.config/systemd/user/mirai-sf-reminders.service ~/.config/mirai-sf/unit-backup/
cp deploy/systemd/mirai-sf-* ~/.config/systemd/user/
systemctl --user daemon-reload

# 4. API を切り替えて確認（commit が $SHA になること）
systemctl --user restart mirai-sf-api.service
curl -fsS http://127.0.0.1:8782/healthz

# 5. タイマーを有効化し、1回ずつ手動で流す
systemctl --user enable --now mirai-sf-backup.timer mirai-sf-restore-drill.timer
systemctl --user start mirai-sf-backup.service
systemctl --user start mirai-sf-restore-drill.service
systemctl --user start mirai-sf-reminders.service
journalctl --user -u mirai-sf-backup -u mirai-sf-restore-drill -u mirai-sf-reminders -n 50 --no-pager
```

切替に失敗したら、退避した unit を戻して `daemon-reload` し、API を再起動する（従来の `dist/` で動く）。

2回目以降は `pnpm ops:release <SHA>` だけでよい。`/healthz` が失敗すると前のリリースへ自動で戻す（DB は戻さない）。

### 9-4. メール（滞留通知・再送）

`preview.conf` に `MAIL_MODE` がなければ、本番の既定どおり `off` になる。この場合の日次保守は下書きTTLだけを実行する。滞留通知と再送を Staging で動かすには、`preview.conf` に `MAIL_MODE`（と `MAIL_APPROVAL_TO` など）を設定する。API も同じ設定を読むので、承認依頼メールも同時に動き出す。

### 9-5. 検証用の差し替え

| 環境変数                         | 既定                               | 用途                                |
| -------------------------------- | ---------------------------------- | ----------------------------------- |
| `MIRAI_SF_ENV_FILE`              | `~/.config/mirai-sf/preview.conf`  | 接続先などの設定ファイル            |
| `MIRAI_SF_HOME`                  | `~/.local/share/mirai-sf`          | `releases/` と `current` の置き場所 |
| `MIRAI_SF_BACKUP_DIR`            | `~/.local/state/mirai-sf/backups`  | バックアップの保存先                |
| `MIRAI_SF_BACKUP_RETENTION_DAYS` | `14`                               | 世代（日）                          |
| `MIRAI_SF_HEALTH_URL`            | `http://127.0.0.1:8782/healthz`    | 切替後に確認するURL                 |
| `MIRAI_SF_RESTART_HOOK`          | なし（`systemctl --user restart`） | 再起動の代わりに実行するファイル    |

`MIRAI_SF_HOME` を差し替えると、`MIRAI_SF_ENV_FILE` と（`--no-restart` でなければ）`MIRAI_SF_RESTART_HOOK` も必須になる。実DB・実サービスを誤って触らないための確認。
