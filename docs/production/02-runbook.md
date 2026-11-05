# 本番（Production）運用手順

対象: 本番環境の構築・リリース・バックアップ・復元・ロールバック・監視。

ログイン・2人目の登録・自己承認拒否・注文書までの限定受入と運用残課題の対応案は [本番業務受入と運用残課題の実施計画](03-business-acceptance-and-operations.md) を参照する。
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
# 見本データ（`seed`）は本番では実行しない。ただしマスタは必須（依頼の dept_code が
# department への FK のため、空だと受付できない）。マスタと管理者だけを登録する:
MIRAI_SF_ENV_FILE=~/.config/mirai-sf/prod.conf node scripts/ops/with-env.mjs pnpm exec tsx scripts/db.ts seed:master
MIRAI_SF_ENV_FILE=~/.config/mirai-sf/prod.conf node scripts/ops/with-env.mjs pnpm exec tsx scripts/db.ts seed:admin
MIRAI_SF_ENV_FILE=~/.config/mirai-sf/prod.conf node scripts/ops/with-env.mjs pnpm exec tsx scripts/db.ts verify

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

# 1. 計画の確認（リリース成果物・DB・サービスを変更しない。fetch による refs 更新のみ）
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

**本番 release は exact-main CI 成功が必須**（2026-11-05 追加）。`prod-release.sh`（→ `release.sh`）は main に含まれることを確認した後、解決した 40 桁 SHA で `scripts/ops/check-release-ci.mjs` を実行し、その SHA の push/main `ci.yml` の最新 attempt と必須 job（quality / e2e / docker）が成功していなければ、リリース成果物・DB・サービスを変更せずに終了する（変更は `git fetch` による refs 更新のみ）。

| ゲートの結果                                               | 本番 release の終了コード | 対応                                                     |
| ---------------------------------------------------------- | ------------------------- | -------------------------------------------------------- |
| 0（確認済み）                                              | 展開へ進む                | —                                                        |
| 75（run 未作成・実行中・再 run race）                      | 75（配備しない）          | CI の完了を待って同じ SHA で再実行する                   |
| 1（失敗・必須 job 欠落/skipped・API 情報不足・照会エラー） | 1（配備しない）           | CI を直して main へ入れ直す。`gh auth status` も確認する |

- `--dry-run` でもゲートを照会し、結果を `[dry-run] exact-main CI ゲート: …` として表示するだけ（終了コードには反映しない）。配備前の確認に使う。
- override / bypass のフラグ・環境変数は無い（fail-closed）。`MIRAI_SF_RELEASE_CI_GATE=0` を渡しても、`prod-release.sh` と本番ホーム（`*-prod`）では無効化できない。
- Staging の `release.sh` 単独利用（手動）は従来どおりゲートを実行しない。Staging 自動配備は `staging-autofollow.sh` が同じゲートを通してから `release.sh` を呼ぶ（`06-staging-parity-and-autofollow.md`）。
- 検証: `pnpm test:ops`（`scripts/ops/tests/prod-release-ci-gate.test.sh`。偽 gh で 0 / 75 / 1・dry-run・Staging 非適用を確認）。

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

- **RPO 1 時間**: `mirai-sf-prod-backup.timer`（前回実行から 55 分、起動 2 分後。RPO 1 時間 = ADR §8-6 の決定）が `pg_dump -Fc` + 同一スナップショットの manifest を `~/.local/state/mirai-sf-prod/backups/` へ出す（0700/0600）。旧「毎時 :05」は timer の 1 分精度で最大間隔が 60 分を超えたため、2026-11-04 に 55 分間隔へ変更した（`docs/production/07` §3-4）。
- 週次: `mirai-sf-prod-restore-drill.timer`（日曜 04:30）が一時DBへ復元して件数と監査ハッシュ連鎖を照合し、必ず消す。
- **オフサイト（Cloudflare R2、ADR §8-7 の決定）**: `prod.conf` の `MIRAI_SF_OFFSITE_CMD=scripts/ops/offsite-r2.mjs` で、毎時の dump と manifest を非公開バケット `mirai-sf-prod-backups`（APAC）へ送り、置いた実体を読み戻して **サイズと SHA-256 の一致**を確かめる。成功すると dump の隣に送信記録 `<dump>.r2.json`（バケット・キー・ハッシュ、0600）を残す。送信に失敗すると backup ユニットは **failed（終了コード 4）** になり、ローカルの dump は残る。認証は wrangler のログイン（OAuth）に依存する。R2 の S3 アクセスキーを用意できたら `rclone copyto` へ差し替える（`MIRAI_SF_OFFSITE_CMD` を差し替えるだけ）。
- **オフサイトからの復元訓練**: `pnpm ops:prod:offsite-drill`。最新の送信記録の dump と manifest を **R2 から取り寄せ**、記録した SHA-256 と照合してから、`restore-drill.sh` と同じ手順（一時DBへ復元 → 件数・監査ハッシュ照合 → 一時DB削除）を実行する。「送れた」ではなく「R2 から復元できる」を確かめるための訓練。
  - 2026-11-03 実測: 取得・SHA-256 一致 → 復元 → 28 テーブル・件数一致・監査連鎖 verify 成功 → 一時DB削除。
- 保持: DB の監査行は削除しない（追記のみ）。**ローカルの**ファイルの世代管理は `MIRAI_SF_BACKUP_RETENTION_DAYS`（既定14日。毎時だと最大 336 世代 = 約 43 MB）。
- **R2 側の保持規則は未設定として記録中**（アプリからは削除しない。最新のクラウド設定は適用前に再取得する）。毎時 128 KB として概算 **約 1.1 GB/年**。**保持日数と対象プレフィックスの承認後**に R2 ライフサイクル規則（例: 90 日で失効）を設定する。S3 アクセスキーは必須ではなく、[公式手順](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)に従い Dashboard / Wrangler / Cloudflare API でも管理できる。期限超過の既存オブジェクトも削除対象になるため、未承認のまま有効化しない。

## 6. ロールバック

```bash
pnpm ops:prod:rollback --dry-run <戻し先SHA>
pnpm ops:prod:rollback <戻し先SHA>
```

- DB は戻さない（migration は additive のみ）。戻す必要がある場合は「別DBへ復元 → 検証 → 切替」。
- 直前のリリースが残っていることを確認する（自動削除はしない）。

## 7. 監視

- **本番の外形監視**: `mirai-sf-prod-healthcheck.timer`（5 分間隔）。`scripts/ops/healthcheck.mjs` を
  `MIRAI_SF_HEALTH_URL=http://127.0.0.1:8783/healthz`・`MIRAI_SF_HEALTH_ENV=production`・
  `MIRAI_SF_HOME=~/.local/share/mirai-sf-prod` で動かす。確認項目は
  `/healthz` 200・`status=ok`・`db.ok=true`・`environment=production`・`commit` と `current/release.env` の一致
  （＋任意で `origin/main` との比較。ずれは warning で失敗にしない）。状態は
  `~/.local/state/mirai-sf-prod/healthcheck.json`（Staging の状態ファイルとは別）。
- **バックアップの鮮度も監視する**（RPO が黙って破れないように）: `MIRAI_SF_HEALTH_BACKUP_DIR` と
  `MIRAI_SF_HEALTH_BACKUP_MAX_AGE_MIN`（既定 90。RPO 1 時間に対する余裕）を設定すると、最新の `*.dump` が
  無い・または指定分より古いときに healthcheck が失敗する。2026-11-03 実測: 正常時
  `最新バックアップ: …（3 分前）`、空ディレクトリと 3 時間前の dump でいずれも NG（終了コード 1）。
- 設定ファイル `prod.conf` は読まない（release.env の COMMIT_SHA だけを照合）。秘密は出力しない。
- 失敗は `systemctl --user --failed` と `journalctl --user -u mirai-sf-prod-healthcheck` で見る。
  失敗はローカル記録（`alerts.jsonl`＋journal err）へ残る（§10）。外部通知（Slack 等）は未設定（通知先・送信方式の承認待ち。§10 の `MIRAI_SF_NOTIFY_CMD` で後から有効化できる）。通知送信自体に Access サービストークンは不要。Access 認証付きの公開経路監視は別課題であり、最小権限の機械認証を設計してから追加する。現行のサービストークン認証は ACCESS_ALLOWED_EMAILS の先頭（なければ seed 管理者メール）の利用者へマッピングし、その権限を引き継ぐため、本番監視用として安易に有効化しない。
- Staging は従来どおり `mirai-sf-healthcheck.timer`（8782・`environment=staging`）。本番と混在させない。

```bash
# 設置・確認（初回だけ。ユニットは deploy/systemd/ から複製）
cp deploy/systemd/mirai-sf-prod-healthcheck.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now mirai-sf-prod-healthcheck.timer
systemctl --user start mirai-sf-prod-healthcheck.service                   # 手動で1回
systemctl --user show -p Result -p ExecMainStatus mirai-sf-prod-healthcheck.service
cat ~/.local/state/mirai-sf-prod/healthcheck.json                          # ok=true / consecutiveFailures=0
```

## 8. 公開（最後・人の承認が必要）

> **公開は不可逆に近い。** 手順 4（DNS 作成）の前に、必ず所有者へ Y/N を取る（SC-03）。
> **2026-11-03 18:13 JST に公開済み**（所有者の Y を得て実施）。1〜5 は完了。以降の再公開・切替も同じく Y/N を取る。

1. ✅ ADR §8 の決定を `docs/production/00-adr.md` §8.1 と `docs/devline/assessment/source-conflicts.md`（SC-02 / SC-03）に記録する。
2. ✅ Cloudflare Zero Trust に本番用 Access アプリを作成する。
   - ホスト名 `sf-prod.mirai-dx-platform.com` / session 12h / auto_redirect_to_identity / OTP
   - ポリシー: `email_domain = mirai-const.co.jp` または `email = kensan1969@gmail.com`
   - **AUD は `prod.conf` の `ACCESS_AUD` と一致させる**（2026-11-03 作成: `7f7129ce…`）。
3. ✅ 本番専用トンネルを作成し、ingress を設定して接続を確認する（Staging のトンネルとは分離）。

   ```bash
   cloudflared tunnel create mirai-sf-prod                 # id: 1007198e-1214-47a4-86a3-09cd542d7cd4
   # ~/.cloudflared/mirai-sf-prod-config.yml に
   #   sf-prod.mirai-dx-platform.com → http://127.0.0.1:8783 と 404 の最終規則を書く
   cloudflared tunnel --config ~/.cloudflared/mirai-sf-prod-config.yml ingress validate   # → OK
   systemctl --user enable --now mirai-sf-prod-tunnel.service                             # 4 コネクションを確認
   cloudflared tunnel info 1007198e-1214-47a4-86a3-09cd542d7cd4
   ```

4. ✅ **（人の承認後）DNS を CNAME で張る。**（2026-11-03 実施）

   ```bash
   # 注意: `cloudflared tunnel route dns <name>` は ~/.cloudflared/config.yml の tunnel を
   # 既定として解決するため、別トンネルに向くことがある（実際に一度 onegate へ向いた）。
   # 必ずトンネル ID を明示し、--overwrite-dns を使う。
   cloudflared tunnel route dns --overwrite-dns 1007198e-1214-47a4-86a3-09cd542d7cd4 sf-prod.mirai-dx-platform.com
   dig +short sf-prod.mirai-dx-platform.com            # → Cloudflare の anycast IP
   ```

   確認: `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' https://sf-prod.mirai-dx-platform.com/`
   → `302 https://winter-lake-f4c9.cloudflareaccess.com/cdn-cgi/access/login/sf-prod.mirai-dx-platform.com…`
   （`kid` / `aud` が Access アプリの AUD `7f7129ce…` と一致すること）。

5. 公開後、受入チェックリスト（§4）を再実行する。API では Access JWT を持てないため、**5（受付→承認→注文書）と 6（自己承認 ERR-105）はブラウザで人が実施**する。
6. 切り戻し: DNS レコードを消し、`systemctl --user stop mirai-sf-prod-tunnel`（アプリ自体は止めない。止めるなら `stop mirai-sf-prod-api` も）。
7. 公開・切り戻しのたびに、下の記録を残す（監査）。

### 8.1 公開記録

| 日時 (JST)    | 操作                       | 承認（Y/N と決定者） | commit   | 結果・実測                                                                                                                                     |
| ------------- | -------------------------- | -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-03 18:13 | DNS CNAME 作成（公開）     | **Y**（所有者）      | 66ea4a3  | `302` → Access ログイン（aud `7f7129ce…` 一致）。`/`・`/login`・`/api/auth/me`・`/healthz` のすべてで未認証は 302。tunnel 4 コネクション。 |
| 2026-11-03 18:13 | 誤トンネルへの CNAME を修正 | —                    | 66ea4a3  | 初回 `route dns mirai-sf-prod` が既定 config の `onegate`（a423aa88…・0 コネクション）を指した。24 秒後に `--overwrite-dns` + トンネル ID 明示で本番へ修正。onegate は接続が無く到達不能、Access はホスト名単位で有効のため情報露出なし。 |

### 8.2 公開前の最終確認（1 行で取る）

- ADR §8.1 の「公開前に再確認」項目: 2（DB名）・5（同一ホスト）・8（Access OTP）・9（職務分離）・10（worker なし）・11（mail off）・12（可用性）・13（保持）・14（公開承認者）を、準備した推奨案のまま進めてよいか。

## 9. 障害時の一次対応

| 症状                     | 一次対応                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `/healthz` が 5xx / 停止 | `systemctl --user status mirai-sf-prod-api`、journal を確認。直近の正常リリースへ rollback |
| DB 接続エラー            | PostgreSQL の起動・接続数・ディスクを確認。復元は「別DBへ」                                |
| 認証できない             | `AUTH_MODE` と `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`、Access アプリの AUD を確認             |
| リリース後に画面が古い   | `dist` の版（`asset-version`）とブラウザのキャッシュを確認                                 |
| バックアップが失敗       | `journalctl --user -u mirai-sf-prod-backup`、空DBでは失敗する（仕様）                      |

## 10. 失敗通知

監視・バックアップ・復元訓練・自動配備の unit が failed になったら、`mirai-sf-onfailure@.service` で記録する（2026-11-05 追加。配置・有効化は Lead が行う）。

- **対象**: 本番の `mirai-sf-prod-healthcheck` / `mirai-sf-prod-backup` / `mirai-sf-prod-restore-drill`、Staging の `mirai-sf-healthcheck` / `mirai-sf-autofollow`。各 `.service` の `[Unit]` に `OnFailure=mirai-sf-onfailure@%n.service` がある。
- **既定の通知先はローカル記録だけ**（外部へは勝手に送らない）:
  1. `~/.local/state/mirai-sf/alerts.jsonl` へ 1 行追記（`{"at","unit","result"}` のみ。0600。秘密は書かない）
  2. journal へ priority=err で 1 行（`journalctl --user -p err -t mirai-sf-onfailure`）
- **任意の外部送信**: `~/.config/mirai-sf/notify.env`（本人所有・0600）に `MIRAI_SF_NOTIFY_CMD=<絶対パス>` があるときだけ、そのコマンドを `<unit> <result> <at>` の引数で実行する（30 秒で打ち切り）。値・コマンドの出力は表示しない。ファイルや変数が無ければスキップして exit 0。外部送信先の追加は所有者の承認後に行う。
- **終了コード**: 0=記録済み（外部送信なし／OK）、2=unit 名が不正（改行・記号。記録しない）、3=ローカル記録に失敗、4=外部送信の設定不正・失敗（ローカル記録は済み）。2〜4 では通知 unit 自身が failed になる（`systemctl --user --failed` に `mirai-sf-onfailure@…` が出ていれば、通知経路の異常）。
- ExecStart は `/bin/sh` と coreutils だけで完結し、git ワークツリーのスクリプトに依存しない（ツリーが壊れているときこそ通知が要るため）。正本は `deploy/systemd/mirai-sf-onfailure.body.sh`。unit の ExecStart 行は手で書かず、`node scripts/ops/tests/onfailure-execstart.mjs` で生成する。`pnpm test:ops` が正本と unit の一致を検証する。

```bash
# 配置（Lead。初回だけ。監視対象の .service も OnFailure 付きの版へ更新する）
cp deploy/systemd/mirai-sf-onfailure@.service \
   deploy/systemd/mirai-sf-prod-{healthcheck,backup,restore-drill}.service \
   deploy/systemd/mirai-sf-{healthcheck,autofollow}.service ~/.config/systemd/user/
systemctl --user daemon-reload

# 疎通確認（監視対象を落とさずに通知 unit だけ起動する）
systemctl --user start mirai-sf-onfailure@test.service
systemctl --user show -p Result -p ExecMainStatus mirai-sf-onfailure@test.service   # success / 0
tail -n 1 ~/.local/state/mirai-sf/alerts.jsonl                                      # {"at":…,"unit":"test","result":"unknown"}
journalctl --user -p err -t mirai-sf-onfailure -n 5 --no-pager

# 日常の確認
tail -n 20 ~/.local/state/mirai-sf/alerts.jsonl
systemctl --user --failed
```

`alerts.jsonl` に記録が増えていたら、記録された unit の journal を見て §9 の一次対応へ進む。疎通確認で書いた `test` の行は残してよい（記録は追記のみ。消す場合は手で編集する）。

## 11. RTO 訓練

`scripts/ops/rto-drill.sh`（`pnpm ops:prod:rto-drill`）は、本番を止めずに「検知→判断→別DBへ最新の R2 dump を復元→検証→切替判断」までの所要時間を段階ごとに計測するリハーサル（2026-11-05 追加。実施は Lead）。

| 段階              | 内容                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `detect`          | 監視の状態（prod の `healthcheck.json`・`alerts.jsonl`）を読む。訓練では実行開始（宣言）を検知時刻とする                                     |
| `decide`          | current リリース・最新の R2 送信記録・一時ポート・一時DB名（`mirai_sf_rto_<ts>`）を確定。前提が欠けていればここで止まる                      |
| `fetch`           | R2 から dump と manifest を取得し、送信記録の SHA-256・サイズと照合（`offsite-drill` と同等）。`--local` ならローカルの最新 dump             |
| `restore`         | 一時DBを作って `pg_restore`                                                                                                                  |
| `verify`          | manifest（件数・監査ログ末尾ハッシュ）との完全一致と `scripts/db.ts verify`（ハッシュ連鎖）                                                  |
| `api`             | current リリースの API を一時DB・`127.0.0.1:8789`（`MAIL_MODE=off`）で起動し、`/healthz` が `status=ok`・`db.ok=true`・commit 一致になるまで |
| `switch_decision` | 切替判断の記録だけ（本番の切替・DNS・Access・サービスは変更しない）                                                                          |
| `cleanup`         | 一時 API を停止し、一時DBを削除（名前が `mirai_sf_rto_` で始まり本番DB名と異なることを検査してから DROP）                                    |

```bash
cd /mnt/storage/Software-Factory/Software-Factory

# 1. 前提の確認（R2 取得・DB 作成・API 起動はしない。レポートも書かない）
pnpm ops:prod:rto-drill --dry-run

# 2. 実施（標準出力に JSON。進行ログは標準エラー。レポートは ~/.local/state/mirai-sf-prod/rto-drill/ に 0600 で保存）
pnpm --silent ops:prod:rto-drill > /tmp/rto-drill.json
node -e 'const r=require("/tmp/rto-drill.json"); console.log(r.result, r.totalSeconds, r.withinTarget); for (const s of r.stages) console.log(s.name, s.seconds, s.ok)'

# R2 の認証（wrangler login）が使えないときの代替（ローカルの最新 dump を使う）
pnpm ops:prod:rto-drill --local
```

- 出力 JSON: `result`（ok/failed）、`totalSeconds`、`targetMinutes`（既定 30。`MIRAI_SF_RTO_TARGET_MIN`）、`withinTarget`、`stages[]`（`name`・`startedAt`・`endedAt`・`seconds`・`ok`・`note`）、`release.commit`、`backup.file`・`ageMinutes`、`tempDb`。
- prod.conf の値は `with-env.mjs` 経由で読むだけで表示しない。一時 API には `DATABASE_URL`（一時DB）・`PORT`・`HOST=127.0.0.1`・`MAIL_MODE=off` を上書きして渡す。API と wrangler の出力本文は表示しない。
- 終了コード: 0=成功、1=失敗（一時DBは削除済み）、2=一時DBを削除できなかった（ログとレポートに出る名前で `dropdb --maintenance-db=postgres --force mirai_sf_rto_…` を手動で実行する）。
- 一時ポートは既定 8789（`MIRAI_SF_RTO_PORT`）。8781/8782/8783 と使用中のポートは拒否する。
- **範囲**: これは「復元して検証し、切替できると判断するまで」の計測。本番の受付停止・切替・Access 確認・受付再開は含まない。全体の RTO（検知から受付再開まで）は、この結果に切替手順（§6 の rollback・§3 の切替）の実測を足して見積もる。結果は `docs/production/07-slo-and-measurement.md` の RTO 欄へ記録する。
- 検証: `pnpm test:ops`（`scripts/ops/tests/rto-drill.test.sh`。偽 pg クライアント・偽 wrangler・偽 API で、DB 名ガード・dry-run・各段階・失敗時の後片付けを確認）。
