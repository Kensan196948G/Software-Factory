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

### 3-1. Access JWT 検証への切替（人の承認後に実施）

認証方式の変更なので、切替は承認を得てから行う。コードが入っただけでは動作は変わらない。

| 環境変数                    | 内容                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN`        | `https://<team>.cloudflareaccess.com`。JWT の `iss` と公開鍵の取得先   |
| `ACCESS_AUD`                | Access アプリの Application Audience (AUD) タグ。JWT の `aud` と照合   |
| `ACCESS_TRUST_EMAIL_HEADER` | `1` で「JWT 未設定時のヘッダ信頼」を明示 opt-in。既定は未設定＝無効。この値が `1` のときだけ APP_ENV の明示が必須で、許可されるのは development / test だけ。`APP_ENV=staging` / `production`、または `1` かつ APP_ENV 未設定では起動エラー（Issue #102） |
| `ACCESS_AUTO_PROVISION`      | `1` で「未登録の Access 利用者を初回ログイン時に自動作成」を明示 opt-in。既定は未設定＝無効（401・`auth.access_denied` / reason=`user_not_registered`）。有効時も作るのは `is_admin=false`・`requester` のみで、`user.provisioned` を監査に残す。`0` / `1` 以外、`APP_ENV=staging` / `production`、`NODE_ENV=production` では起動エラー（Issue #102 完了条件 3） |

実値は `preview.conf`（0600）だけに置き、リポジトリへ書かない。

未登録の利用者は、JWT が有効でも既定では作成しない（401）。staging / production では `ACCESS_AUTO_PROVISION=1` 自体が起動エラーになるため、新規利用者は管理API（`/api/admin/users`、`docs/api.md` §6）で事前に作成する。開発・テストでだけ opt-in を使う。

| 設定                                 | 動作                                                            |
| ------------------------------------ | --------------------------------------------------------------- |
| 両方あり（`AUTH_MODE=access`）       | JWT 必須。下記の検証に通らなければ未認証（`/healthz` は応答）   |
| 両方なし                             | **fail-closed**。ヘッダを信頼せず未認証（401）。`NODE_ENV=production` なら起動時に warn。`ACCESS_TRUST_EMAIL_HEADER=1` を明示した場合だけヘッダ信頼を opt-in でき、許可されるのは APP_ENV を明示した development / test。`APP_ENV=staging` / `production`、または `1` かつ APP_ENV 未設定では起動エラー（Issue #102） |
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
4. **fail-closed 版を配備するときは、配備前に発行済みのセッションを失効させる**（`docs/production/17` §7）。fail-closed は「JWT のない新規リクエスト」を止めるが、修正前にヘッダ信頼で発行された Cookie は `SESSION_TTL_HOURS`（既定 12 時間）まで有効なため。

切り戻し: 2つの変数を削除して再起動する。ただし 2026-11-06 以降は **fail-closed**（ヘッダ信頼なし）なので、2 変数を外すと誰もログインできなくなる。staging / production では `ACCESS_TRUST_EMAIL_HEADER=1` による回避は起動エラーになる。戻す必要がある場合は、先に JWT の 2 項目を再設定するか、旧セッションを失効したうえで Access を外した状態を所有者へ申告する（`docs/production/17` §7）。

**2026-11-06 追記（Staging で実施。記録は `docs/production/17-staging-access-jwt-rollout-20261106.md`）**:

- 今後の推奨順序（2026-11-06 の実施順は、再起動 05:10 → バックアップ 05:11 → 旧セッション失効で、下記と異なる。実際の順序と時刻は 17 の §3 の表を参照）:
  1. **事前に** DB をバックアップする。
  2. `preview.conf` を 0600 で退避し、新版は原文を保ったまま JWT の 2 項目（`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`）だけを追加する。2 項目が Access アプリと組織の値に一致することを、値を表示せずに照合する。
  3. API を再起動する。healthcheck の実行と重ならない時刻を選ぶ。重なると停止中の旧プロセスが 503 を返し、OnFailure の記録が残る（2026-11-06 に 1 件発生）。
  4. JWT 導入前に作られた旧セッションを失効する。条件（DB 名・件数の上限・再起動時刻より前・有効件数）を同じトランザクションで再検証してから行う。
- 切替後の拒否の確認（2026-11-06）: メールヘッダ単独・偽の JWT・偽の Client-Id・偽の Cookie ＋ メールヘッダはいずれも 401 だった。session と app_user は増えていない。
  - Cookie のみ（JWT なし）の拒否は、隔離したテストで確認したもの（`tests/integration/access-jwt.test.ts`「発行済みの Cookie だけでは通らない」）。実環境で確かめたのは**偽の Cookie** が 401 になることまでで、正規の経路で発行された実 Cookie を JWT なしで送った場合は未確認。
- **未完了**: Access の正規の経路（ブラウザで OTP ログイン → 有効な JWT → コンソール表示）は人の確認が済んでいない。上の「切替手順」3 の「Access ログイン後の画面表示」は 2026-11-06 時点で未確認のまま。
- ヘルスとの境界: `/healthz`・`/readyz` は JWT なしでも認証不要で 200 を返す。JWT が付いた要求は onRequest フックが検証する（`src/api/app.ts`）が、ルート自体は認証を要求しない。したがって health の 200 をログイン合格の証拠にしない。ログイン後の画面確認を省略しない。
- 切り戻すと再びヘッダを信頼する状態に戻る（Issue #102）。切り戻したらセッションを再度失効し、所有者へ申告する。

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

- `/healthz` の定期確認は `mirai-sf-healthcheck.timer`（5分ごと、§7-4）。公開URL（Access 経由）側の外形監視は、Access の bypass か サービストークンが必要で未実施
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

### 7-4. Staging の外形監視（`mirai-sf-healthcheck.timer`）

`scripts/ops/healthcheck.mjs` を systemd user timer で5分ごとに実行し、Staging の異常を `systemctl --user --failed` と journal に残す。`mirai-sf-api.service` の `Restart=always` だけでは、プロセスが生きていても DB が落ちている・環境や commit が違う、といった異常に気づけないため。

| #   | 確認項目                                                                                       | 失敗時の扱い           |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | `http://127.0.0.1:8782/healthz` が HTTP 200 を返す（`MIRAI_SF_HEALTH_URL` で変更可）           | exit 1（failed）       |
| 2   | `status=ok` かつ `db.ok=true`                                                                  | exit 1（failed）       |
| 3   | `environment=staging`                                                                          | exit 1（failed）       |
| 4   | `/healthz` の `commit` が `~/.local/share/mirai-sf/current/release.env` の `COMMIT_SHA` と一致 | exit 1（failed）       |
| 5   | （任意）`git -C <repo> rev-parse origin/main` と一致（release 反映漏れの検知）                 | warning のみ（exit 0） |

- 5 は `git fetch` をしない。`origin/main` は最後に fetch した値なので、古いと誤警告することがある。fetch 後に再実行して解消を確認する。
- 失敗すると oneshot unit が `failed` になり、`systemctl --user --failed` と `journalctl --user -u mirai-sf-healthcheck` で確認できる。timer は止まらず5分ごとに再試行し、復旧すると `復旧: 連続 N 回の失敗から回復しました` の1行を出す。
- 状態（連続失敗数・最終失敗理由・最終成功時刻・warning）は `~/.local/state/mirai-sf/healthcheck.json`（0600）に残す。監視自体の状態ファイルであり、秘密値は含めない。
- 秘密情報は出力しない。`preview.conf`（`DATABASE_URL` など）は読まず、DB にも触らない。`/healthz` の本文はログへ出さず、確認済みの項目（`status` / `environment` / `db.ok` / `commit`）だけを出す。`with-env.mjs` と同じく設定値は表示しない。URL は資格情報・クエリを落として出す。
- 実行元は `current` ではなく常設のチェックアウト（`~/Projects/Software-Factory-Project` → `/mnt/storage/Software-Factory/Software-Factory`）。監視がリリースのデプロイに依存しないため。リポジトリの場所が違う場合は drop-in（`~/.config/systemd/user/mirai-sf-healthcheck.service.d/`）で `WorkingDirectory` と `ExecStart` を差し替える。

有効化（稼働中の API・tunnel・worker は止めない）:

```bash
# 1. マージ済みの main をチェックアウトへ反映（unit はチェックアウトから実行する）
cd /mnt/storage/Software-Factory/Software-Factory
git switch main && git pull --ff-only

# 2. unit を配置して読み込み直す
cp deploy/systemd/mirai-sf-healthcheck.service deploy/systemd/mirai-sf-healthcheck.timer ~/.config/systemd/user/
systemctl --user daemon-reload

# 3. 1回手動で実行し、成功してから有効化する（failed のまま有効化しない）
systemctl --user start mirai-sf-healthcheck.service
systemctl --user show -p Result -p ExecMainStatus mirai-sf-healthcheck.service
journalctl --user -u mirai-sf-healthcheck -n 20 --no-pager

# 4. timer を有効化
systemctl --user enable --now mirai-sf-healthcheck.timer
systemctl --user list-timers mirai-sf-healthcheck.timer
```

確認:

```bash
systemctl --user list-timers mirai-sf-healthcheck.timer        # NEXT が5分以内
journalctl --user -u mirai-sf-healthcheck -n 20 --no-pager     # healthcheck OK
cat ~/.local/state/mirai-sf/healthcheck.json                    # ok=true / consecutiveFailures=0
systemctl --user --failed | grep mirai-sf-healthcheck || echo 'failed なし'
```

失敗時の一次対応:

1. `systemctl --user --failed` と `journalctl --user -u mirai-sf-healthcheck -n 50` で、どの確認項目が落ちたかを見る。
2. `curl -fsS http://127.0.0.1:8782/healthz` の応答、`~/.local/share/mirai-sf/current/release.env` の `COMMIT_SHA`、`systemctl --user status mirai-sf-api.service` を突き合わせる。
   - `status` が `ok` でない／`db.ok` が false → `journalctl --user -u mirai-sf-api` と PostgreSQL の状態を確認する。API の再起動は `systemctl --user restart mirai-sf-api.service`（原因を記録してから行う）。
   - `commit` が一致しない → `pnpm ops:rollback <SHA>` か `pnpm ops:release <SHA>` で `current` を正しいリリースへ戻す。反映漏れなら release する。
   - `environment` が `staging` でない → `preview.conf` の `APP_ENV` と接続先を確認する（値はログ・Issue へ貼らない）。
   - `origin/main` の warning だけ → 失敗ではない。fetch 後に再実行して解消を確認し、release 漏れなら release する。
3. 直したら `systemctl --user start mirai-sf-healthcheck.service` で即時再確認する。成功すれば `failed` は消え、復旧ログが1行出る（次回の timer 実行を待ってもよい）。
4. メンテナンスで監視を止めるときは `systemctl --user disable --now mirai-sf-healthcheck.timer`。unit ファイルは消さず、再開は `systemctl --user enable --now mirai-sf-healthcheck.timer`。

## 8. 既知の制約

- Access のサービストークン発行は、現在のAPIトークンに `access-service-token.write` が無いため未実施。公開URL（Access 経由）側の外形監視は未実施で、§7-4 の healthcheck は origin（127.0.0.1:8782）を直接見る。公開URL側を自動化する場合はトークン権限の追加が必要。
- CI は `.github/workflows/` のポリシーゲートにより未適用（`docs/patches/README.md`）。
- ローカルホスト停止時は Preview も停止する（仕様）。

## 9. Staging の運用（バックアップ・固定リリース）

`scripts/ops/` と `deploy/systemd/` の雛形で、Preview を commit に固定して運用する。

| 操作           | コマンド                                             | 内容                                                                                    |
| -------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| バックアップ   | `pnpm ops:backup`                                    | `pg_dump -Fc` を `~/.local/state/mirai-sf/backups/` へ（0700/0600）。既定14日で世代管理 |
| 復元ドリル     | `pnpm ops:restore-drill`                             | 最新を一時DB `mirai_sf_drill_<ts>` へ復元し、件数とハッシュ連鎖を検証して一時DBを消す   |
| リリース       | `pnpm ops:release [--dry-run] <SHA>`                 | main に含まれる commit だけを展開し、切替と `/healthz` の commit 確認まで行う           |
| ロールバック   | `pnpm ops:rollback [--dry-run] <SHA>`                | 展開済みのリリースへ切替（DB は戻さない）                                               |
| 日次保守       | `pnpm ops:reminders`                                 | preview.conf の DB に対して滞留通知・再送・下書きTTLを実行                              |
| 監査アーカイブ | `pnpm ops:audit:archive`                             | 同じDBに対して §7-2 を実行                                                              |
| DB 検証        | `pnpm ops:db:verify`                                 | 同じDBに対して `db:verify` を実行                                                       |
| 自動追従       | `bash scripts/ops/staging-autofollow.sh [--dry-run]` | origin/main に追従し、health 確認・失敗時は直前のリリースへ戻す（timer は雛形。未導入） |

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

| 環境変数                         | 既定                                       | 用途                                         |
| -------------------------------- | ------------------------------------------ | -------------------------------------------- |
| `MIRAI_SF_ENV_FILE`              | `~/.config/mirai-sf/preview.conf`          | 接続先などの設定ファイル                     |
| `MIRAI_SF_HOME`                  | `~/.local/share/mirai-sf`                  | `releases/` と `current` の置き場所          |
| `MIRAI_SF_REPO`                  | このスクリプトを含むリポジトリ             | git リポジトリ（release / origin/main 比較） |
| `MIRAI_SF_BACKUP_DIR`            | `~/.local/state/mirai-sf/backups`          | バックアップの保存先                         |
| `MIRAI_SF_BACKUP_RETENTION_DAYS` | `14`                                       | 世代（日）                                   |
| `MIRAI_SF_HEALTH_URL`            | `http://127.0.0.1:8782/healthz`            | 切替後・定期監視で確認するURL                |
| `MIRAI_SF_HEALTH_STATE_FILE`     | `~/.local/state/mirai-sf/healthcheck.json` | 外形監視の状態ファイル（検証用に差し替え）   |
| `MIRAI_SF_RESTART_HOOK`          | なし（`systemctl --user restart`）         | 再起動の代わりに実行するファイル             |

`MIRAI_SF_HOME` を差し替えると、`MIRAI_SF_ENV_FILE` と（`--no-restart` でなければ）`MIRAI_SF_RESTART_HOOK` も必須になる。実DB・実サービスを誤って触らないための確認。

### 9-6. 開発ライン worker（雛形。導入は CTO）

画面の投入から実 job を動かす worker。詳細は `docs/devline/real-runner.md` 13 章。

**前提の未解決**: `preview.conf` は `NODE_ENV=production` で、この値では docker-claude の投入（ERR-405）も worker も拒否される。Staging で動かすには、この拒否をどう扱うかを先に決める。

```bash
# 1. イメージ（版は docs/devline/real-runner.md 7 章と同じ）
docker build -f deploy/devline/Dockerfile.runner -t msf-devline-runner:2.1.316 deploy/devline
docker build -f deploy/devline/Dockerfile.proxy  -t msf-devline-egress-proxy:v1 deploy/devline

# 2. 資格情報（0600。値を画面やシェルの履歴に出さない）。ANTHROPIC_API_KEY と DEVLINE_GITHUB_TOKEN
install -m 600 /dev/null ~/.config/mirai-sf/devline-secrets.env

# 3. preview.conf へ追記（API と worker の両方が読む）
#    DEVLINE_WORKER_ENABLED=1
#    DEVLINE_RUNNER_KIND=docker-claude
#    DEVLINE_TARGET_REPOS=Kensan196948G/Software-Factory-Sandbox:1440860477
#    DEVLINE_SECRETS_FILE=<資格情報の絶対 path>

# 4. ユニット（current のリリースを参照する）
cp deploy/systemd/mirai-sf-worker.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user restart mirai-sf-api.service
systemctl --user enable --now mirai-sf-worker.service
journalctl --user -u mirai-sf-worker.service -n 50
```

起動を拒否すると（資格情報なし、イメージなし、公開リポジトリなど）exit 1 で終わり、理由をログに出す。fake へ落とさない。繰り返し失敗するとユニットは止まる。`pnpm ops:release` と `pnpm ops:rollback` は、worker が動いていれば再起動する（動いている AI は止まり、次の起動で同じ工程からやり直す。止まっている worker は起動しない）。止める: `systemctl --user disable --now mirai-sf-worker.service`（動いている AI は止まり、job は次の起動で同じ工程からやり直す）。

### 9-7. Staging の main 自動追従（雛形。有効化は Lead）

main が進んだら Staging を自動で追従させる。既存の `release.sh` / `rollback.sh` をそのまま使い、新しい配備手順は足さない。

```bash
bash scripts/ops/staging-autofollow.sh --dry-run   # 計画だけ（fetch と状態ファイルのみ更新）
bash scripts/ops/staging-autofollow.sh             # 手動で追従
```

- 流れ: `flock` → `git fetch origin main` → `current` と比較して同一なら no-op（`commit`・`environment`・
  `db.ok` のずれは失敗）→ 実行元が **main・clean** か確認 → 手動運用と同じ **`.ops.lock`** を取得
  （取れなければ触らず exit 75）→ `release.sh <40桁SHA>` → `/healthz` の `commit`・`environment`・`db.ok` を
  独立に確認 → 不一致なら `rollback.sh <直前のSHA>` → 成功後に古い `releases/` を整理。
- 終了コード: `0`=追従済み/成功, `1`=失敗（旧版へ戻した場合を含む）, `2`=戻せなかった, `3`=破壊的 migration で中止,
  `75`=autofollow／手動 release/rollback が実行中、または実行元が main・clean でない（skip。timer は成功扱い）。
- 実行元が main・clean でない間は配備しない（exit 75）。`WorkingDirectory` は main を保つ常設チェックアウトにする。
- 成功後に current/previous と直近 N 世代（`MIRAI_SF_AUTOFOLLOW_KEEP_RELEASES`、既定 5）だけ残す。
  `MIRAI_SF_AUTOFOLLOW_PRUNE=0` で無効化。本番ホーム（`*-prod`）では整理しない。
- timer の雛形: `deploy/systemd/mirai-sf-autofollow.{service,timer}`（10 分ごと、`SuccessExitStatus=75`）。
  実行が長引くと次回は 75 で skip し、二重配備しない。
- 実測・導入・検証の詳細は [06-staging-parity-and-autofollow.md](production/06-staging-parity-and-autofollow.md)。
- 本番には適用しない。本番は §3（runbook）の手動リリースのまま。
