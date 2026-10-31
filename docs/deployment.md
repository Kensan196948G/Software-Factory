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
SEED_ADMIN_EMAIL=kensan1969@gmail.com SEED_ADMIN_PASSWORD=... pnpm exec tsx scripts/db.ts migrate
# seed も同様に実行

# 2. ビルド
pnpm build

# 3. 設定（0600）
node scripts/setup-preview.mjs     # ~/.config/mirai-sf/preview.conf

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

### 3-1. Access JWT 検証への切替（人の承認後に実施）

認証方式の変更なので、切替は承認を得てから行う。コードが入っただけでは動作は変わらない。

| 環境変数             | 内容                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com`。JWT の `iss` と公開鍵の取得先 |
| `ACCESS_AUD`         | Access アプリの Application Audience (AUD) タグ。JWT の `aud` と照合 |

実値は `preview.conf`（0600）だけに置き、リポジトリへ書かない。

| 設定                                 | 動作                                                            |
| ------------------------------------ | --------------------------------------------------------------- |
| 両方あり（`AUTH_MODE=access`）       | JWT 必須。下記の検証に通らなければ未認証（`/healthz` は応答）   |
| 両方なし                             | 従来どおりヘッダを信頼。`NODE_ENV=production` なら起動時に warn |
| 片方だけ、またはドメインの形式が不正 | 起動エラー（`AUTH_MODE=access` のとき）                         |

検証内容:

- 公開鍵は `<team>/cdn-cgi/access/certs` から取得する。キャッシュは1時間で、kid 不一致でも取り直す（取得は最短30秒に1回）。取得に失敗しても手元の鍵は取得から24時間まで使い、それを過ぎると拒否する。
- `alg` は RS256 のみ。署名、`iss`（完全一致）、`aud`（`ACCESS_AUD` を含む）、`exp`（必須）、`nbf`（ある場合）を確認する。`exp` / `nbf` には30秒の時計ずれを許容する。
- 利用者は JWT の `email` から決める（`ACCESS_ALLOWED_DOMAIN` / `ACCESS_ALLOWED_EMAILS` で判定）。`Cf-Access-Authenticated-User-Email` と `Cf-Access-Client-Id` は使わない。
- `email` がないサービストークンは、`common_name` が `ACCESS_SERVICE_TOKEN_IDS` にあるときだけ通す。
- Cookie のセッションがあっても毎回 JWT を検証する。JWT がなければ未認証、Cookie と別人の JWT なら JWT の利用者のセッションを作る。

切替手順:

1. Zero Trust のダッシュボードで対象 Access アプリの AUD を確認する。
2. `preview.conf` に2つの変数を追加し、`systemctl --user restart mirai-sf-api`。
3. `journalctl --user -u mirai-sf-api` に warn がないこと、Access ログイン後の画面表示、Tunnel を経由しない `127.0.0.1:8782` への `Cf-Access-Authenticated-User-Email` 付きリクエストが `/api/auth/me` で 401 になることを確認する。

切り戻し: 2つの変数を削除して再起動する。

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
