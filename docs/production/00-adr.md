# 本番基盤 ADR（Production Architecture Decision Record）

| 項目     | 内容                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| 文書ID   | ADR-PROD-001                                                                                                       |
| 版       | 1.0（提案）                                                                                                        |
| 日付     | 2026-11-03                                                                                                         |
| 状態     | **提案。所有者の承認前。本書は本番作業の許可ではない。**                                                           |
| 決定者   | 所有者（SC-02 は組織方針の管理者も関与、SC-03 は所有者）                                                           |
| 対象     | 本番環境（Production）のトポロジ・DB・秘密・復旧・費用・統制                                                       |
| 基準     | main `b2ae9e3` / Staging current `b2ae9e32e54c97c8f34457b10f7940f21fe0c64a`                                        |
| 実測日時 | 2026-11-03 11:39–11:48 JST（Asia/Tokyo）                                                                           |
| 制約     | 作成にあたりコード・インフラ・設定を変更していない。稼働中サービスを操作していない（`--dry-run` と読み取りのみ）。 |

本書は「本番をどう作るか」の意思決定文書である。仕様の正本は `docs/みらいSF 詳細仕様書 V1.0.html`、既存の検証環境の運用は `docs/deployment.md` 9章、残存リスクは `docs/limitations.md`、未決の衝突は `docs/devline/assessment/source-conflicts.md`（SC-02 / SC-03）に従う。**本書はそれらの仕様・状態・ID を変更しない。**

---

## 0. 要約

1. **推奨は案A**（同一ホスト + 本番DB `mirai_sf_prod` + 本番ホスト名の新設 + 既存 Cloudflare Tunnel / Access 基盤の再利用。Access は本番用アプリを追加）を**条件付き**で採る。追加の月額費用は既存資源の範囲でほぼ 0 円。既存の固定リリース・バックアップ・復元ドリル・rollback の仕組みを最小の変更で使える案である。
2. ただし案Aは**単一障害点**（ホスト・電源・回線・ディスク・PostgreSQL クラスタ）を持つ。仕様の受付稼働率 99.5%（平日 8:00–19:00、案）を現構成で保証できない。可用性を必須要件にするなら案C（別ホスト/クラウド移設）へ進む。
3. **本番DBは `mirai_sf_prod`**。バックアップは `pg_dump -Fc` + 同一スナップショットの manifest、日次 02:30（既存）に加えて**毎時**または WAL アーカイブで RPO 1 時間を満たす。**オフサイト保存は必須**（現状なし）。復元は「別DBへ復元 → 検証 → 切替」で行い、DB は rollback しない。
4. **秘密は `~/.config/mirai-sf/prod.conf`（0600）に分離**し、Staging の `preview.conf` と共用しない。Cloudflare Access は本番ホスト名用に新設し、`ALLOW_SELF_APPROVAL=0`、`REQUIRE_ORIGIN_SECRET=1`、Access JWT 検証（PR #27）を前提にする。GitHub トークンは `DEVLINE_GITHUB_TOKEN` と用途別に分離し、API キーは worker だけに渡す。
5. **本番公開は常に人の承認を必須**とする（SC-03 は候補2 を推奨）。現行の `release.sh` には承認ゲートも CI 成果物の照合もないため、**実装が終わるまで人間がリリース操作を行い、AI は準備と検証だけを行う**。
6. 未決事項は §8 に Y/N・番号選択で列挙した。**§8 の決定と SC-02 / SC-03 の記録が揃うまで、本番環境・本番DB・本番DNSを作らない。**

---

## 1. 現状の実測（Staging）

### 1.1 測定条件

- ホスト: `kensan1969`（Ubuntu 24.04.5 LTS、16 コア、メモリ 30 GiB）。`date -Is` = `2026-11-03T11:45:13+09:00`。
- リポジトリ: `/mnt/storage/Software-Factory/Software-Factory`、`main` = `b2ae9e3`。
- 実行したのは読み取りコマンド、`pnpm ops:release --dry-run`、`pnpm ops:rollback --dry-run` のみ。`systemctl` の start/stop/restart、DB の作成・変更、Cloudflare の設定変更は行っていない。
- コマンドと主要出力は付録A に置く。

### 1.2 固定リリース

| 確認                | 実測値                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `current`           | `/home/kensan/.local/share/mirai-sf/current` → `releases/b2ae9e32e54c97c8f34457b10f7940f21fe0c64a`       |
| `release.env`       | `COMMIT_SHA=b2ae9e32e54c97c8f34457b10f7940f21fe0c64a`（1行）                                             |
| `.release-complete` | `2026-11-02T13:56:49Z`（= 2026-11-02 22:56 JST）                                                         |
| 展開済みリリース    | 10 件（2026-10-31〜2026-11-02）。すべての SHA は git リポジトリに存在する。git tag は 0 件。             |
| サイズ              | `releases/` 合計 604 MB、現行リリース 1 件 423 MB（`node_modules` と `dist` を含む）                     |
| 起動中の実体        | systemd unit は `current` を `WorkingDirectory` にし、`preview.conf` の後に `current/release.env` を読む |

`/healthz` の `commit` が `current` の SHA と一致していることを実測した（1.6）。したがって「commit 固定リリース」は稼働中の API にも反映されている。

### 1.3 systemd user units（実測）

`deploy/systemd/` の 7 ファイル（api / backup service+timer / reminders / restore-drill service+timer / worker）は `~/.config/systemd/user/` の実体と**すべて一致**した（`diff` で差分なし）。Tunnel はテンプレートがなく、実体のみ。

| unit                                        | 状態                         | 主な内容（実測）                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mirai-sf-api.service`                      | active / enabled             | 2026-11-02 22:56:50 起動、NRestarts 0。`WorkingDirectory=~/.local/share/mirai-sf/current`、`preview.conf` → `release.env`、`node dist/api/server.js`、`Restart=always`、`127.0.0.1:8782` |
| `mirai-sf-tunnel.service`                   | active / enabled             | `/usr/local/bin/cloudflared --config ~/.cloudflared/mirai-sf-config.yml tunnel run`。`After/Wants=mirai-sf-api.service`、`Restart=always`                                                |
| `mirai-sf-worker.service`                   | active / enabled             | 2026-11-02 22:56:51 起動。`current` を参照。`Restart=on-failure`、`StartLimitIntervalSec=600` / `StartLimitBurst=5`、`KillSignal=SIGTERM` / `TimeoutStopSec=120`                         |
| `mirai-sf-backup.service` + `.timer`        | 直近 success / timer enabled | timer は毎日 02:30。直近 2026-11-03 02:30:01→02:30:02（**1秒**、exit 0）。次回 2026-11-04 02:30                                                                                          |
| `mirai-sf-restore-drill.service` + `.timer` | 直近 success / timer enabled | timer は日曜 03:30。直近 2026-11-01 03:30:02→03:30:33（**31秒**、exit 0）。次回 2026-11-08 03:30                                                                                         |
| `mirai-sf-reminders.service` + `.timer`     | 直近 success / timer enabled | timer は毎日 08:30。直近 2026-11-03 08:30:01→08:30:02（**1秒**、exit 0）。`REMINDER_DAYS=3`、`MAIL_OUTBOX_DIR` は `current` の外                                                         |

補足（実測）:

- API は `127.0.0.1:8782` のみを listen する（`ss -ltnp`）。Tunnel の ingress は `sf.mirai-dx-platform.com → http://127.0.0.1:8782`、既定は `http_status:404`。
- worker は active だが、`journalctl --user -u mirai-sf-worker.service` は `-- No entries --`（journal のローテート済み）。動作の最終確認は unit の起動時刻まで。
- `~/.config/mirai-sf/unit-backup/` に初回切替前の unit が退避されている。

### 1.4 Cloudflare Tunnel / Access / DNS（実測）

| 項目                    | 実測値                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zone                    | `mirai-dx-platform.com`、status `active`、plan **Free Website（price 0 USD）**（Cloudflare API）                                                              |
| DNS                     | `sf` CNAME → `91280c04-3009-4c7f-a739-9e37f0808e6e.cfargotunnel.com`、`proxied=true`、TTL auto、modified `2026-10-28T03:29:10Z`                               |
| Tunnel                  | `mirai-sf` / `91280c04-3009-4c7f-a739-9e37f0808e6e`、status **healthy**、**4 コネクション**、colo は `nrt05` / `nrt18` / `nrt15` / `nrt09`（作成 2026-10-28） |
| Tunnel 設定             | `~/.cloudflared/mirai-sf-config.yml`（0600）。`protocol: http2`、credentials-file は `~/.cloudflared/<uuid>.json`（**0400**）                                 |
| Access アプリ           | `Mirai Software Factory 受付ステーション`（id `5c812603-…`）、`self_hosted`、domain `sf.mirai-dx-platform.com`、**session 12h**、作成 2026-10-28T03:30:27Z    |
| Access ポリシー         | **1 件のみ**。`allow` / precedence 1 / include `email_domain = mirai-const.co.jp`、exclude・require なし、作成 2026-10-28                                     |
| Access サービストークン | **0 件**（API で確認）                                                                                                                                        |
| Zero Trust 組織         | auth domain `winter-lake-f4c9.cloudflareaccess.com`（作成 2026-06-24）                                                                                        |
| 公開 URL                | `https://sf.mirai-dx-platform.com/` は **302** で `…cloudflareaccess.com/cdn-cgi/access/login/…` へ。`/healthz` も同じ 302                                    |
| ローカル URL            | `http://127.0.0.1:8782/healthz` は **200**（Access を経由しない）                                                                                             |
| Access の契約           | **未確認**。`GET /accounts/{id}/subscriptions` は 403（Billing Read 権限なし）。シート数・プランは取得できていない                                            |

**既存文書との差異（実測が優先）**:

- `docs/deployment.md` は Access ポリシーに「管理者アカウント（allow）」があるとしているが、2026-11-03 の API 実測では **`email_domain` の 1 ポリシーだけ**。特定アドレス・管理者の allow は見当たらない。
- `docs/deployment.md` は Tunnel の 4 コネクションを `nrt01 / nrt16` と記録しているが、実測は `nrt05 / nrt18 / nrt15 / nrt09`（日時差によるもの。障害ではない）。
- `docs/limitations.md` は「CI は未適用」としているが、`ci.yml` は main にあり、Required Checks も適用済み（1.8）。同文書の 2026-11-02 時点の記述である。

### 1.5 PostgreSQL（ローカル）

| 項目                     | 実測値                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| バージョン               | PostgreSQL **16.15**（Ubuntu 16.15-1.pgdg24.04+2）                                                                                                                                       |
| クラスタ                 | `16/main`、port 5432、online、data directory `/var/lib/postgresql/16/main`                                                                                                               |
| サービス                 | `postgresql` は **active** だが **boot 時 disabled**（`systemctl is-enabled postgresql` = `disabled`）                                                                                   |
| listen                   | `localhost,192.168.0.185,172.18.0.1`（`postgresql.conf` 60行）。実際の LISTEN は `127.0.0.1:5432` と `192.168.0.185:5432`                                                                |
| pg_hba                   | `local all all peer`、`host all all 127.0.0.1/32 scram-sha-256`、`host all all ::1/128 scram-sha-256`。加えて他DB用の個別行。**`mirai_sf` 向けの LAN 許可行は見当たらない**              |
| クラスタ全体             | **333 データベース**、合計 **7,137 MB**（他プロジェクトと共用）                                                                                                                          |
| `mirai_sf`               | 10 MB、public のテーブル **28**、`schema_migrations` **12 件**（`0001_init.sql`〜`0012_devline_release.sql`）、`audit_log` **142 行**（最大 id 142）                                     |
| 接続                     | アプリは Unix socket 経由。現行の接続文字列はユーザー指定がなく、OS ユーザー `kensan`（**superuser**）で接続する。`mirai_sf` の DB owner も `kensan`                                     |
| 専用ロール               | `mirai_sf_app`（非 superuser、login 可、createdb 不可）が存在し、public の 112 件の権限を持つ。ただしアプリの接続経路がこのロールになっているかは未確認（`preview.conf` を読まない方針） |
| WAL / アーカイブ         | `archive_mode = off`、`archive_command = (disabled)`、`wal_level = replica`、`max_connections = 100`                                                                                     |
| 稼働中のスナップショット | `pg_dump -Fc` と manifest（テーブル件数 + `audit_log` 末尾ハッシュ）。直近は `mirai_sf-20261102T173001Z.dump`（**180,231 bytes**）                                                       |

**バックアップの実測**:

- 保存先 `~/.local/state/mirai-sf/backups/`（0700、ファイル 0600）。
- 自動 dump 14 件（2026-10-31〜2026-11-03）+ 手動 `mirai_sf-pre0007-…dump` 1 件。サイズは 81 KB〜180 KB。
- 世代管理は既定 **14 日**（`MIRAI_SF_BACKUP_RETENTION_DAYS` の既定。`backup.sh` 実装）。手動 dump は世代管理の対象外。
- manifest は 28 テーブルと `#audit_tip 31441ba72e9cbf88d472e7874df69bc87b0d9f64c6e4ce841439b97fa9043830` を含む（直近 dump の例）。
- **DB とバックアップは同じルートディスク上**（`/var/lib/postgresql` と `/home/kensan/.local/state`。`/` は 936 GB 中 752 GB 使用、残 145 GB、**84% 使用**）。オフサイトコピーはない。
- `rclone` は `/usr/bin/rclone` に導入済み。オフサイト同期の仕組みは未設定。

**監査・ログの実測**:

- `audit_log` は追記のみ（`audit_log_append_only` トリガ、0001_init.sql 213–221行）で、ハッシュ連鎖を持つ。`verifyAuditChain` と `/api/audit-logs`（管理者のみ）がある。
- 監査アーカイブは `scripts/audit-archive.ts`（保持 365 日）だが、**timer はなく、最終ファイルは `audit-2026-10-28.jsonl.gz`（42 KB）のみ**。それ以降の定期実行は未確認。
- journald は 523.7 MB を使用しているが、`journalctl --list-boots` は**現在のブート（2026-11-03 07:21 以降）だけ**。過去のログはローテートで参照できない。保持設定は未確認。

### 1.6 `/healthz` の内容（実測）

`http://127.0.0.1:8782/healthz` の 200 応答:

```json
{
  "status": "ok",
  "app": "mirai-sf-intake",
  "version": "0.1.0",
  "commit": "b2ae9e32e54c97c8f34457b10f7940f21fe0c64a",
  "environment": "staging",
  "db": { "ok": true, "latencyMs": 1.4 },
  "now": "2026-11-03T02:39:46.105Z"
}
```

- `commit` は `release.env` / `current` と一致する。`environment` は `staging`。`db.ok=true`。
- 秘密・接続文字列・個人情報は含まない。一方で commit・環境名・DB 状態を**認証なしでローカルに返す**。公開側は Access により 302 で保護される。
- `release.sh` / `rollback.sh` は `status=ok`、`db.ok=true`、`commit` 一致を切替成功の条件にしている（`scripts/ops/lib.sh` の `ops_wait_healthy`）。

### 1.7 ホストとリソース（実測）

| 項目         | 実測値                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------- |
| OS           | Ubuntu 24.04.5 LTS                                                                                |
| CPU / RAM    | 16 コア / 30 GiB（空き 17 GiB）                                                                   |
| 負荷         | load average 8.47 / 8.39 / 7.79（1/5/15分）                                                       |
| 稼働         | up 4 days 12:56。最終ブート 2026-10-29 22:45                                                      |
| ディスク     | `/` 936 GB（使用 752 GB、84%）、`/mnt/storage` 9.1 TB（使用 5.8 TB、64%）                         |
| 時刻         | Asia/Tokyo、NTP active、clock synchronized                                                        |
| 同居サービス | 同一 user の systemd に多数のプロジェクト（`codip-*`、`mirai-c3scs-*`、`ai-helpdesk-*` 等）が稼働 |

### 1.8 リポジトリ統制・CI（実測）

| 項目              | 実測値                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| リポジトリ        | `Kensan196948G/Software-Factory`、**private**、default branch `main`                                                                                                                                                          |
| Branch protection | あり。required status checks = `quality` / `e2e`（app_id 15368）、`strict=true`、`enforce_admins=true`、`required_conversation_resolution=true`、force push 禁止、branch 削除禁止。**required pull request reviews は未設定** |
| Rulesets          | **0 件**（protection は legacy API 側で設定）                                                                                                                                                                                 |
| CODEOWNERS        | なし                                                                                                                                                                                                                          |
| Merge 設定        | squash / merge commit / rebase のすべて許可、auto-merge 有効、merge 後の branch 削除は無効                                                                                                                                    |
| Actions           | `allowed_actions=all`、`sha_pinning_required=false`                                                                                                                                                                           |
| 直近の CI（main） | `b2ae9e3` の push run が **success**（2026-11-02T13:34Z）。直近の PR run には failure もある（`8aecca3`）                                                                                                                     |
| PR #27            | `approval: Cloudflare Access JWT の署名検証`。state **OPEN**、`mergeable=CONFLICTING`、head `303423c`。quality/e2e は 2026-10-31 に success                                                                                   |
| CI の内容         | `quality`（typecheck / lint / unit / migration 空DB・冪等 / seed / db:verify / integration / build / secret scan）と `e2e`（Postgres service + Playwright）、`docker`（実 runner イメージ）                                   |

**注意**: branch protection は「main への merge」を守るが、**本番リリース（どの commit を本番へ出すか）を守る仕組みは別にない**。`release.sh` は CI の結果も成果物のハッシュも確認しない（3.5・5.1）。
（2026-11-05 追記: CI 結果の確認は範囲を限定して訂正する。Staging での `release.sh` の直接利用は CI 結果を確認しない。本番 wrapper（`prod-release.sh`）は exact-main CI を確認する（PR #92、§7.2）。成果物ハッシュ・承認の確認は引き続き無い）

### 1.9 本番用の成果物がないこと（実測）

| 対象                           | 結果                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `~/.config/mirai-sf/prod.conf` | **存在しない**（`preview.conf`・`devline-secrets.env`・`local.json`・`unit-backup/` のみ） |
| 本番DB                         | **存在しない**（`mirai_sf_prod` なし。`%prod%` かつ `mirai%` の DB なし）                  |
| 本番 systemd unit              | **存在しない**（`mirai-sf-*` の 9 ファイルのみ。prod 用 unit なし）                        |
| 本番ホスト名                   | 候補 `sf-prod` / `sf-production` / `mirai-sf-prod` / `sf-stg` の DNS レコードは **0 件**   |
| オフサイトバックアップ         | なし（`rclone` は導入済みだが設定なし）                                                    |

### 1.10 実測と既存文書の差異（要更新）

| 文書・記述                                                        | 実測（2026-11-03）                                                 | 扱い                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `docs/limitations.md`「CI は未適用」                              | CI は適用済み。Required Checks も適用済み                          | 本書では実測を根拠にする。文書は別途更新 |
| `docs/limitations.md` Backlog「CI 適用と Required Checks 化」     | CI は適用済み、Required Checks も `quality` / `e2e` で設定済み     | 同上                                     |
| `docs/deployment.md` Access ポリシーの管理者行                    | API 実測は `email_domain` の 1 ポリシーのみ                        | 本番では明示的に設計し直す               |
| `docs/deployment.md` Tunnel の colo                               | `nrt05/nrt18/nrt15/nrt09`（記録は `nrt01/nrt16`）                  | 日時差。障害ではない                     |
| `docs/database.md`「本番移行時に最小権限ロール」                  | `mirai_sf_app` は存在するが、アプリの接続が superuser 経由の可能性 | 本番では接続経路まで分離する             |
| `docs/devline/assessment/branch-protection-proposal.md`「未適用」 | 適用済み（2026-11-03 実測）                                        | 適用者・適用日時は未確認                 |

---

## 2. 本番トポロジの比較

### 2.1 前提

- アプリは **Node 22 + Fastify + SPA**。DB は **PostgreSQL 16 を Unix socket で利用**。`/healthz` は Node プロセスが返す。
- 開発ラインの **worker は Docker コンテナ（docker-claude）を起動し、成果物を取得してローカル Docker へ配備する**（`docs/devline/real-runner.md` 13章、`deploy/devline/`）。この処理は Cloudflare Workers では実行できない。
- 固定リリースは `~/.local/share/mirai-sf/releases/<sha>` に展開し、`current` symlink を切り替える。`release.sh` / `rollback.sh` / `backup.sh` / `restore-drill.sh` はこの前提で動く。
- 組織方針 §4 は本番基盤を Cloudflare（Pages / Workers）と Neon PostgreSQL とする。所有者は 2026-10-31 に「Neon を使わずローカル PostgreSQL を使う」と回答し、組織方針の改定方針としたが、**2026-11-01 時点で例外の記載はなく、方針が優先する**（SC-02）。
- 本番の可用性目標は仕様（案）で受付 99.5%（平日 8:00–19:00）、開発ライン 99.0%、RTO 4 時間 / RPO 1 時間（NFR-37、案）。数値は未確定（Q-12）。

### 2.2 比較表

| 観点               | 案A: 同一ホスト + 本番DB + 本番ホスト名 + 既存 Tunnel/Access                                                                        | 案B: Cloudflare Workers/Pages + 外部マネージドDB（Neon 等）                                                      | 案C: 別ホスト/クラウド移設                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 構成               | 既存ホストに prod 用 API（別ポート）・`mirai_sf_prod`・`prod.conf`・prod 用 unit を追加。Tunnel に本番ホスト名を追加（または2本目） | Workers/Pages にアプリを移植。DB は Neon 等。Docker worker は別基盤へ分離                                        | 新ホスト/VM に Node 22 + PG16 + systemd + cloudflared + Docker を構築。DB はローカル or マネージド |
| 障害域             | ホスト・電源・回線・ディスク・PG クラスタが**単一**                                                                                 | Cloudflare と DB はマネージド。アプリの障害域は分散                                                              | 既存ホストから分離。VM 1 台なら依然単一                                                            |
| 可用性             | 99.5% を**保証できない**。再起動・ディスク・PG 停止が直撃                                                                           | 高可用を狙える。ただし移植後の品質次第                                                                           | 案Aより改善。冗長化には追加構成が必要                                                              |
| 追加費用           | **ほぼ 0 円/月**（既存ホスト・ドメイン・Tunnel・Access。オフサイトは R2 無料枠内の見込み）                                          | Workers Paid 最低 **$5/月** + Neon Launch 目安 **約 $15/月** + Access 契約（未確認）+ 移植工数                   | 新ホスト/VM の見積 + マネージドDB（参考 Neon 約 $15/月）+ 運用工数。**見積未取得**                 |
| 移行コスト         | **小〜中**（設定・unit・DNS・Access・バックアップ・監視。コード変更は原則不要）                                                     | **大**（Fastify→Workers、DB ドライバ、ファイルシステム、Docker worker、メール outbox、監査アーカイブの作り直し） | **中**（同コードを新ホストへ。unit・設定・DNS・監視・バックアップの再構築）                        |
| 既存コードとの整合 | **高い**（`release.sh` / `rollback.sh` / `backup.sh` / `restore-drill.sh` を環境変数で再利用可能）                                  | **低い**（特に devline worker は Workers で動かない）                                                            | **高い**（Docker と systemd が使える）                                                             |
| ローカル前提       | Docker・Unix socket・ローカルファイルをそのまま使える                                                                               | 使えない。外部 API/オブジェクトストレージへ置換                                                                  | そのまま使える                                                                                     |
| 組織方針 §4        | **違反（例外の記録が必要）**                                                                                                        | **適合**                                                                                                         | マネージドDBを選べば適合可能。ローカルPGなら例外が必要                                             |
| セキュリティ       | 既存ホストの他プロジェクトと同居。秘密・DB の blast radius が広い                                                                   | 外部サービスへ秘密を置く。データ所在・契約の確認が必要                                                           | 分離できる。ホストの hardened 運用が必要                                                           |
| 運用               | 既存の運用手順・障害対応を流用。1 ホストで完結                                                                                      | Cloudflare 管理画面中心。ベンダー依存とコスト管理                                                                | ホスト 2 台の patching・監視・バックアップ。運用負荷は増える                                       |
| 判定               | **条件付きで推奨（本ADRの案）**                                                                                                     | 現時点では非推奨（移植とスコープ変更が前提）                                                                     | 可用性・方針・分離の要件次第で**次点**                                                             |

### 2.3 案Aの構成（推奨案の具体形）

```
Browser
  → https://<本番ホスト名>（Cloudflare プロキシ）
  → Cloudflare Access（本番用アプリ・ポリシー）
  → Cloudflare Tunnel `mirai-sf`（既存。本番ホスト名の ingress を追加）
     または本番用の2本目 Tunnel
  → http://127.0.0.1:8783（本番 API。別ポート）
  → PostgreSQL 16 `mirai_sf_prod`（可能なら本番用の別クラスタ / 別ポート）
```

- 本番用の `MIRAI_SF_HOME` を `~/.local/share/mirai-sf-prod` などに分離し、`current` / `releases` を Staging と混ぜない。
- 本番用 unit（例: `mirai-sf-prod-api.service`、`mirai-sf-prod-backup.timer`、`mirai-sf-prod-worker.service`）を新設する。既存テンプレートは `preview.conf` と `mirai-sf-api.service` を前提にしているため、そのままでは本番に使えない。
- `prod.conf` は `~/.config/mirai-sf/prod.conf`（0600）。`NODE_ENV=production` / `APP_ENV=production`、`PORT=8783`、`HOST=127.0.0.1`、`DATABASE_URL=postgresql:///mirai_sf_prod?host=/var/run/postgresql`、`ALLOW_SELF_APPROVAL=0`、`ALLOW_IMPORT=0`、`REQUIRE_ORIGIN_SECRET=1`、`COOKIE_SECURE=1`、`AUTH_MODE=access`、Access の許可範囲、`SESSION_SECRET` は本番専用の新規値。
- Tunnel に本番ホスト名を追加する場合、`cloudflared` の設定変更は Tunnel の再起動を伴う。**Staging と本番で Tunnel を共有すると設定変更・障害が相互に影響する**。分離を優先するなら本番用 Tunnel を別に作る（Cloudflare の追加費用はなし。運用は 1 unit 増える）。
- Access は本番ホスト名用に**別アプリ**を作る。既存アプリの `self_hosted_domains` に追加する方法もあるが、Staging と本番でポリシー・セッション・監査が混ざるため推奨しない。

### 2.4 案B（Cloudflare Workers/Pages + 外部マネージドDB）

- 長所: Cloudflare の可用性・DDoS 耐性・グローバル配信を使える。Neon 等は PITR・ブランチ・マネージドバックアップを持つ。組織方針 §4 に適合する。
- 短所（本リポジトリ固有）:
  1. **devline worker が Docker を必要とする**。Workers ではコンテナ実行ができず、`docker load` / 内部ネットワーク配備 / 成果物の照合という現在の中核機能を移植できない。
  2. Fastify の HTTP サーバ、`fs` を使うメール outbox・監査アーカイブ・リリース展開を Workers の実行モデルへ作り直す必要がある。
  3. DB は Unix socket・peer 認証前提。Neon は TLS + 接続情報 + プーリングへ変更が必要。
  4. 30 分に及ぶ成果物取得・Docker 配備は Workers の実行時間・CPU 制限と相性が悪い。Queues / Durable Objects / 別ホストへの分離が必要。
  5. Access JWT 検証（PR #27）や監査・承認の設計を、Workers の認証モデルに合わせて再検証する必要がある。
- 費用: Workers Paid 最低 $5/月（Cloudflare 公式、2026-10-02 更新）、Neon Launch は小規模DBで目安約 $15/月（Neon 公式、2026-10-31 更新）。別途 Access の契約・シート（未確認）と移植工数。
- 結論: **本番の第一候補にはしない**。組織方針が絶対でローカルPGの例外が認められない場合、または devline worker を本番スコープから外す決定がある場合に再評価する。

### 2.5 案C（別ホスト/クラウド移設）

- 長所: 既存ホストの障害・負荷・ディスク・同居サービスから分離できる。Docker と systemd が使えるため既存コードの変更は小さい。マネージドDBを選べば組織方針 §4 にも適合できる。
- 短所: ホスト/VM の調達・構築・patching・監視・バックアップ・費用が増える。VM 1 台なら可用性は案Aと同程度（単一障害点）。ネットワーク・電源・DNS・Access の設計をやり直す。移行期間中は 2 環境の運用が必要。
- 費用: 新ホスト/VM の見積が必要（**未取得**）。マネージドDBは参考として Neon Launch 約 $15/月。運用工数（構築・移行・保守）が加算される。
- 結論: **案Aの単一障害点を受容できない場合、または組織方針の例外が認められない場合の次点**。可用性を要件にするなら、VM 1 台ではなく冗長化（マルチAZ/マネージドDB/2 台構成）まで設計する。

### 2.6 推奨案と理由

**推奨: 案A（条件付き）。**

理由:

1. 所有者の 2026-10-31 の決定（ローカル PostgreSQL）と現行コード・運用に一致する。案Bはこの決定を覆し、案Cは調達と構築が必要になる。
2. `release.sh` / `rollback.sh` / `backup.sh` / `restore-drill.sh` が既にあり、`MIRAI_SF_HOME` / `MIRAI_SF_ENV_FILE` / `MIRAI_SF_HEALTH_URL` / `MIRAI_SF_RESTART_HOOK` で本番向けに差し替えられる（ただし 5.1 の未対応点を除く）。
3. devline worker の Docker 実行を維持できる。
4. 追加の月額費用がほぼ 0 円で、既存の Cloudflare・ドメイン・ホストを使える。
5. 本番までの距離が最短で、受入・復旧訓練を早期に始められる。

**条件（すべて満たすまで本番を作らない）**:

- SC-02: 組織方針 §4 の例外（ローカル PostgreSQL）が所有者と方針管理者により記録される。記録がなければ案Aは方針違反。
- SC-03: 本番公開の承認ルールが決まり、少なくとも人間の公開承認が記録される。
- 職務分離: `ALLOW_SELF_APPROVAL=0`、Access ログインの管理者自動付与の是正、複数ユーザー/SSO の方針決定。
- 認証: Access JWT 検証（PR #27）を merge し、`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` を本番に設定する。
- バックアップ: オフサイト保存、RPO 1 時間を満たす方式（毎時 dump または WAL）、復元訓練の本番実施。
- 監視: 外部からの死活監視（Access サービストークンまたは別経路）とアラート。
- ホスト: PostgreSQL の boot 時自動起動、ディスク容量の監視、本番用ロール/クラスタの分離。
- リリース: CI 成果物の照合または「ホスト再ビルド」のリスク受容、承認ゲート、rollback 手順の訓練。

### 2.7 案Aのリスクと対策

| #    | リスク                                                  | 影響                                       | 対策                                                                                | 状態   |
| ---- | ------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- | ------ |
| A-1  | ホスト・電源・回線の停止                                | 受付停止。RTO 4 時間を超えうる             | UPS、回線冗長、監視、手順書、復旧訓練。受容するなら所有者の明示承認                 | 未対応 |
| A-2  | ルートディスク 84% 使用。DB とバックアップが同一        | ディスク枯渇で DB/バックアップ停止         | PG とバックアップを `/mnt/storage` へ移す。容量監視。ログ・release の世代管理       | 未対応 |
| A-3  | PostgreSQL が boot 時 disabled                          | 再起動後に DB が起動せず API だけ起動      | `systemctl enable postgresql`、API unit に `After/Wants=postgresql.service`         | 未対応 |
| A-4  | 333 DB を抱える共用クラスタ。負荷・アップグレードの影響 | レイテンシ悪化・計画外停止                 | 本番用の別クラスタ/別ポート、または別ホスト。リソース制限と監視                     | 未対応 |
| A-5  | バックアップが同一ディスク・オフサイトなし              | ホスト障害で DB とバックアップを同時に喪失 | `rclone` で R2/別ホストへ同期。リストア訓練を四半期ごと（仕様案）                   | 未対応 |
| A-6  | RPO が最大 24 時間（日次 dump、WAL なし）               | 仕様の RPO 1 時間を満たさない              | 毎時 dump または WAL アーカイブ。方式は §8 の決定                                   | 未対応 |
| A-7  | Access JWT 未検証（PR #27 未 merge）                    | ヘッダ偽装による認証迂回の余地             | PR #27 を merge。origin を 127.0.0.1 のみに固定。`REQUIRE_ORIGIN_SECRET=1`          | 未対応 |
| A-8  | Access ログインが初回に管理者・3役を自動付与            | 職務分離・最小権限を満たさない             | 本番では自動付与を廃止し、管理者が明示的に役割を付与。SSO/グループ管理              | 未対応 |
| A-9  | 本番リリースが CI 結果・成果物ハッシュを確認しない      | 不合格ビルドの配備                         | 承認ゲートと CI 成果物の照合を追加。当面は人間が確認                                | 未対応 |
| A-10 | `release.sh` が `mirai-sf-worker.service` 固定で再起動  | Staging worker を誤って再起動              | 本番用の restart hook / unit 名へ変更。当面は本番リリース時に Staging worker を停止 | 未対応 |
| A-11 | 外部監視なし。`/healthz` は Access 配下                 | 障害の検知遅れ                             | Access サービストークン発行（`access-service-token.write`）と外部プローブ、アラート | 未対応 |
| A-12 | journald の保持が短い                                   | 障害調査・監査証跡の不足                   | 外部ログ保存（R2/別ホスト）と保持期間の設定                                         | 未対応 |
| A-13 | 単一の運用者                                            | 属人化・bus factor                         | 手順書、2 人目の訓練、チェックリスト                                                | 未対応 |
| A-14 | 本番データの分類・保持が未決                            | 法令・社内規程違反                         | Q-09（保持 7 年案）とデータ分類の決定。作り物データのみの間は影響小                 | 未決   |

### 2.8 移行の段階（案A）

| 段階                | 内容                                                                                                                                    | 完了条件（Exit criteria）                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Phase 0: 決定       | §8 の未決事項、SC-02 / SC-03 の記録、予算・ホスト名・公開承認者の決定                                                                   | 所有者の決定が `source-conflicts.md` と本書に記録される。作業開始の承認がある                   |
| Phase 1: 前提整備   | 本番DB/ロール、`prod.conf`、本番 unit、DNS/Access、PR #27、`ALLOW_SELF_APPROVAL=0`、オフサイト、監視、PostgreSQL 自動起動、ディスク移設 | 受入チェックリスト（5.3）の「前提」がすべて Yes。Staging に影響がないことを確認                 |
| Phase 2: リハーサル | 本番と同じ設定で、ダミーDBへリリース・復元・rollback・監視を訓練                                                                        | 復元訓練・rollback 訓練・受入スモークが成功。RTO/RPO の実測値を記録                             |
| Phase 3: 切替       | 本番DB作成 → migrate/seed → 初回リリース → Access/DNS 有効化 → スモーク → 30 分重点監視（仕様案）                                       | `/healthz` が本番 commit / environment=production / db.ok。公開 URL が Access 302。承認記録あり |
| Phase 4: 運用       | 日次バックアップ、週次/四半期の復元訓練、監査アーカイブ、月次レビュー、パッチ                                                           | 監査・バックアップ・監視の記録が継続。四半期の RTO/RPO 実測                                     |
| Phase 5: 再評価     | 可用性・コスト・スコープをレビューし、案C/B への移行可否を判断                                                                          | 年次または重大障害後に判断を記録                                                                |

---

## 3. 本番DB

### 3.1 名称とロール

| 項目   | 決定案                                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB 名  | **`mirai_sf_prod`**（既存の `mirai_sf` / `mirai_sf_dev` / `mirai_sf_test` と分離）                                                                 |
| 接続   | `postgresql:///mirai_sf_prod?host=/var/run/postgresql`（Unix socket）または `127.0.0.1` + scram                                                    |
| ロール | `mirai_sf_prod_owner`（DDL/migration 用、非 superuser）と `mirai_sf_prod_app`（DML のみ、DDL 不可）に分離                                          |
| 現状   | `mirai_sf` の owner は `kensan`（**superuser**）。`mirai_sf_app` は存在するが、アプリの接続経路がこのロールかは未確認。本番は superuser を使わない |
| 参考   | 他プロジェクトには `*_owner` / `*_app` の分離例がある（`accc_owner` / `accc_app` 等）。同じ形を採る                                                |

- 本番 DB は可能なら**別クラスタ**（別ポート）に置く。同一クラスタに置く場合でも、少なくともロール・スキーマ権限・接続数を分離し、他プロジェクトの障害・負荷の影響を受けることをリスクとして記録する。
- migration 実行ユーザー（owner）とアプリ実行ユーザー（app）を分ける。`scripts/db.ts` は `MIGRATION_DATABASE_URL`（なければ `DATABASE_URL`）で migrate する。`with-env.mjs` は親プロセスの `MIGRATION_DATABASE_URL` を遮断するが、`prod.conf` に書けば子へ渡るため、**`prod.conf` に `DATABASE_URL`（app）と `MIGRATION_DATABASE_URL`（owner）を分けて書く運用で分離できる**。ただし `pending-migrations.sh` と `backup.sh` は `DATABASE_URL`（app）で DB を読むため、app ロールに `schema_migrations` の SELECT と dump 用の読み取り権限を与えるか、スクリプト側の対応が必要（未確認・未実装）。

### 3.2 バックアップ

| 項目       | 決定案                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 方式       | `pg_dump -Fc` + 同一スナップショットの manifest（件数 + `audit_log` 末尾ハッシュ）。既存 `scripts/ops/backup.sh` を使う                     |
| 頻度       | 日次 02:30（既存）。**RPO 1 時間を目標にするなら毎時**、または WAL アーカイブ（PITR）。どちらを採るかは §8 の決定                           |
| 保持       | 既定 14 日。本番は **30 日**を提案（`MIRAI_SF_BACKUP_RETENTION_DAYS=30`。スクリプトは日数指定のみ）                                         |
| オフサイト | 各 dump の後に `rclone` で **非公開の R2 バケットまたは別ホスト**へ同期。保存先は暗号化・アクセス制限・別アカウントの資格情報。**現状なし** |
| 事前       | リリース・migration の直前に `backup.sh` が自動実行される（`release.sh`）。手動 dump は世代管理の対象外                                     |
| 検証       | dump は `pg_restore --list` で読めることを確認。週次/四半期の復元ドリルで manifest と照合                                                   |
| 保存場所   | `MIRAI_SF_BACKUP_DIR` を本番専用に分離（例: `~/.local/state/mirai-sf-prod/backups`）。DB と同じディスクを避ける                             |
| 注意       | 現在のバックアップは DB と同じルートディスク上。ホスト障害で同時に失う。オフサイトは必須                                                    |

費用の目安: dump は 81〜180 KB。R2 の無料枠 10 GB/月（Standard）に十分収まる。R2 の保存は $0.015/GB-month（Cloudflare 公式、2026-10-30 更新）。

### 3.3 復元手順

**基本方針: DB は rollback しない。復元は「別DBへ復元 → 検証 → 切替」で行う。**

1. 復元対象の dump と manifest を選ぶ（`mirai_sf_prod-YYYYMMDDTHHMMSSZ.dump` と `.manifest.tsv`）。オフサイトから取得する場合は取得後にハッシュ/サイズを確認する。
2. `createdb --maintenance-db=postgres --template=template0 --encoding=UTF8 mirai_sf_prod_restore_<ts>` で復元先を作る。
3. `pg_restore --exit-on-error --no-owner --no-privileges -d mirai_sf_prod_restore_<ts> <dump>` で復元する。
4. manifest と復元先の件数・`audit_log` 末尾ハッシュを `diff` で照合する（既存 `restore-drill.sh` と同じ方法）。
5. `scripts/db.ts verify`（監査ハッシュ連鎖を含む）を復元先に対して実行する。
6. アプリの `DATABASE_URL` を復元先へ切り替え、API を再起動し、`/healthz` と業務スモークを確認する。
7. 旧 DB は削除せず保持する。切替日時・実行者・dump 名・検証結果・切替理由を記録する。
8. 復元訓練は `scripts/ops/restore-drill.sh` を使う。一時 DB `mirai_sf_drill_<ts>` を作成し、manifest 照合と `db:verify` の後に必ず削除する（実 DB は書き換えない）。2026-11-01 の実測は 31 秒で成功。

**未実測**: 本番サイズでの復元時間、オフサイトからの取得時間、切替を含む RTO 全体。Phase 2 で実測する。

### 3.4 RTO / RPO

| 項目     | 仕様（案）                        | 現状（Staging 実測）                                      | 本番の目標案                                                                 |
| -------- | --------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| RTO      | 4 時間以内（NFR-37、案）          | 復元ドリル 31 秒（10 MB）。切替・検知を含む実測はなし     | **4 時間以内**。四半期の復元訓練で実測（仕様）。検知・判断・切替・検証を含む |
| RPO      | 1 時間以内（NFR-37、案）          | 日次 dump のみ、`archive_mode=off` のため**最大 24 時間** | **1 時間以内**。毎時 dump または WAL/PITR。方式決定は §8                     |
| 復元訓練 | 四半期ごと（仕様）                | 週次（日曜 03:30、直近 2026-11-01 成功）                  | 週次（Staging 相当）+ 四半期（本番）。実測値を記録                           |
| 可用性   | 受付 99.5%（平日 8:00–19:00、案） | 単一ホスト。実測なし                                      | 案Aでは保証不可。所有者の受容または案C                                       |

根拠:

- RTO 4 時間は仕様（案）の値。復元ドリルが 31 秒で成功しているため、DB 復元自体は小さい。一方で、障害検知・判断・DNS/Access・アプリ切替・業務確認を含む全体は未測定であり、4 時間は「訓練で達成を確認する目標」として扱う。
- RPO 1 時間は現状の日次 dump では達成できない（最大 24 時間）。`archive_mode=off` の実測値が根拠。**RPO を 1 時間にするなら毎時 dump か WAL アーカイブの追加が必須**。仕様目標を緩和する場合は所有者の明示判断が必要（§8）。
- 仕様の「四半期の復元訓練」は、現在の週次ドリルより緩い。本番は仕様に合わせて四半期の実測を行い、Staging の週次は継続する。

### 3.5 migration 運用

| 項目       | 内容                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原則       | **additive のみ**。破壊的変更（DROP / TRUNCATE / 大量 DELETE / 型変更 / 名前変更 / 不可逆 migration）は行わない                                                                                           |
| 記録       | `schema_migrations` に適用済みを記録。migration は `db/migrations/NNNN_*.sql`。空DBからの再実行と冪等性を CI で確認                                                                                       |
| 実行       | `release.sh` が未適用 migration を確認し、事前バックアップ → `tsx scripts/db.ts migrate` → `current` 切替 → 再起動 → healthz                                                                              |
| 破壊的検知 | `scripts/ops/pending-migrations.sh` が `DROP TABLE` / `DROP COLUMN` / `TRUNCATE` / `DELETE FROM` / 型変更 / 名前変更等を文字列照合し、**DB にも current にも触らず exit 3** で停止                        |
| 検知の限界 | 文字列照合による補助でありレビューの代わりではない。`drop constraint` / `drop trigger` の作り直しは対象外。SQL の分割・コメント・動的 SQL は誤検知/見逃しがありうる。**本番は人間のレビューを必須**にする |
| 失敗時     | DB は戻さない。forward fix またはバックアップからの復元（別DBへ復元 → 切替）。`db.ts rollback` は「additive のみ。復元か forward fix」と明示して拒否する                                                  |
| 本番の追加 | 承認ゲート（SC-03）、migration のレビュー記録、実行前のバックアップ確認、実行後の `db:verify` と監査ハッシュ確認。**実装は未着手**                                                                        |
| 禁止       | `dropdb` / `TRUNCATE` / 不可逆 migration を本番で実行しない。`reset` は `_dev`/`_test` と `--yes` のみ（AGENTS.md §2-3）                                                                                  |

補足: `scripts/db.ts` の migration は `MIGRATION_DATABASE_URL` を優先し、なければ `DATABASE_URL` を使う。本番で owner/app を分離するには `prod.conf` に両方を書く。ただし `pending-migrations.sh` と `backup.sh` は `DATABASE_URL` を使うため、app ロールの読み取り権限設計かスクリプト変更が必要（未確認）。

### 3.6 データ保持

- `request` / `approval` / `audit_log` は追記・論理削除が基本で、物理削除しない。`audit_log` は UPDATE/DELETE をトリガで拒否する。
- 仕様（案）は完了後 7 年（Q-09）。現状の保存期間は未設定（`docs/limitations.md` Q-09）。本番の保持年数・アーカイブ先・削除手順は §8 で決める。
- 監査アーカイブは 365 日で世代管理する実装だが、timer がなく最終実行は 2026-10-28。**本番では timer 化とオフサイト保存が必要**。
- DB 所有者はトリガを無効化・DROP できるため、改ざん完全防止ではない（M-5）。本番は owner ロールの分離と外部へのハッシュ先頭保存を検討する。

---

## 4. 秘密管理

**本書には秘密値を書かない。** 以下は「置き場所・権限・分離・ローテーション」の決定案である。

### 4.1 設定ファイル

| ファイル                                 | 用途                                         | 権限（実測/要件）      | 状態                                 |
| ---------------------------------------- | -------------------------------------------- | ---------------------- | ------------------------------------ |
| `~/.config/mirai-sf/prod.conf`           | 本番の環境変数（EnvironmentFile）            | **0600**（所有者のみ） | **未作成**。本書の決定後に人間が作成 |
| `~/.config/mirai-sf/preview.conf`        | Staging の環境変数                           | 0600（実測）           | 既存。本番と共用しない               |
| `~/.config/mirai-sf/devline-secrets.env` | `ANTHROPIC_API_KEY` / `DEVLINE_GITHUB_TOKEN` | 0600（実測）           | 既存。本番で使うかは §8              |
| `~/.config/mirai-sf/local.json`          | ローカル開発用                               | 0600（実測）           | 既存。本番では使わない               |
| `~/.cloudflared/<tunnel>.json`           | Tunnel 資格情報                              | 0400（実測）           | 既存。権限を維持                     |

要件:

- `prod.conf` はリポジトリ・PR・ログ・画面・Memory に置かない（AGENTS.md §2-2）。`with-env.mjs` は 0600 より緩い場合に警告するが、**失敗はしない**ため、運用で 0600 を確認する。
- `SESSION_SECRET` は Staging と別の新規値にする。`ORIGIN_SHARED_SECRET` も本番専用にする。
- `SEED_ADMIN_PASSWORD` は空にし、初期管理者は一度だけ手動で作る。パスワードを会話・Issue・PR に書かない。
- 秘密のローテーション手順（誰が、いつ、どの単位で）を運用に持つ。漏えい時は該当トークンを失効し、監査に記録する。

### 4.2 Cloudflare Access

| 項目             | 決定案                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 公開経路         | 本番ホスト名 → Cloudflare プロキシ → Access → Tunnel → `127.0.0.1:<prod port>`。origin はインターネットへ公開しない                                                                                 |
| Access アプリ    | 本番ホスト名用に**別アプリ**を作る。session は 12h 以下（Staging は 12h）。既存アプリの流用はしない                                                                                                 |
| ポリシー         | 既定は `email_domain = mirai-const.co.jp` の allow。本番は**特定アドレスまたは IdP グループ**へ絞ることを推奨。管理者行を明示的に作る                                                               |
| MFA / SSO        | 現在はワンタイムパスワード（メール）。Entra ID SSO は未実装（L-01、NFR-08）。本番の認証方式は §8 で決める                                                                                           |
| JWT 検証         | 現行コードは `cf-access-authenticated-user-email` ヘッダを信頼する（`src/api/auth.ts`）。**署名検証は PR #27 で提案中、未 merge**。本番は merge 後に `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` を設定する |
| サービストークン | 現在 0 件。外部監視・自動 E2E に必要。発行には API トークンの `access-service-token.write` が必要（未付与、L-11）                                                                                   |
| サービス認証     | `AUTH_MODE=access`。`ACCESS_ALLOWED_EMAILS` / `ACCESS_ALLOWED_DOMAIN` / `ACCESS_SERVICE_TOKEN_IDS` を本番用に設定                                                                                   |
| Origin 秘密      | 本番は `REQUIRE_ORIGIN_SECRET=1`（Staging の生成値は 0）。`TRUST_PROXY=1`、`COOKIE_SECURE=1`                                                                                                        |
| 注意             | Access を外すと認証されない（フェイルクローズ）。Access の無効化・ポリシー全開放をしない。Cloudflare アカウントは他プロジェクトと共用のため、変更権限と監査を分ける                                 |

### 4.3 GitHub トークンの分離

| トークン               | 用途                                                                                | 置き場所                      | 本番の扱い                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`         | 旧来の Issue 作成（fake runner 経路）。`GITHUB_REPO` と組で使う                     | `preview.conf`（Staging）     | 本番では**使わない**か、最小権限の専用トークンに置換。Staging の値をコピーしない                                                |
| `DEVLINE_GITHUB_TOKEN` | 実 runner の Issue 作成・PR merge。API は `DEVLINE_SECRETS_FILE` からこれだけを読む | `devline-secrets.env`（0600） | 本番で devline を動かす場合のみ。対象リポジトリを限定した fine-grained token。worker コンテナには渡さない                       |
| `ANTHROPIC_API_KEY`    | 実 AI runner の推論                                                                 | `devline-secrets.env`（0600） | worker のみが読む。API プロセスには渡さない。予算上限を設定                                                                     |
| ホストの `gh` 認証     | 開発・CI の操作用                                                                   | `~/.config/gh/hosts.yml`      | 本番の配備・merge に使わない。`setup-preview.mjs` は `gh auth token` を `GITHUB_TOKEN` に書くため、本番で同スクリプトを使わない |

- トークンは**用途別・リポジトリ別・最小権限**にする。広い個人トークンを本番の API/worker に渡さない（M-6 の残存リスク）。
- トークンを argv・環境変数の一覧・ログ・PR・Issue・画面に出さない。`docker` の argv にも載せない（`--env` で引き継ぐ実装）。
- 漏えい時は即時失効し、`docs/limitations.md` / 監査に記録する。定期的な棚卸し（誰がどのトークンを持つか）を行う。
- 本番で devline worker を動かさない場合、`DEVLINE_WORKER_ENABLED` を 0 にし、`DEVLINE_RUNNER_KIND` を `fake` 以外にしない。`NODE_ENV=production` では `APP_ENV=staging` の明示がない限り実 runner は拒否される（実装）。

### 4.4 API キー・その他

- AI の API キーは worker の資格情報ファイルだけに置く。API プロセスは読まない。キーはコンテナの argv に載せない。
- SMTP 認証情報は `prod.conf`（0600）または環境変数だけに置く。本番のメールは既定 `MAIL_MODE=off`。有効化は §8。
- Cloudflare API トークン（Tunnel/DNS/Access 操作用）は運用者の手元に置き、アプリの設定ファイルへ入れない。必要権限だけを付与し、使わないときは失効する。
- 秘密管理の専用ツール（1Password / SOPS / Vault 等）は未導入。必要なら §8 で決める。現状は 0600 ファイル + OS 権限 + 監査で運用する。

---

## 5. Rollback と受入基準

### 5.1 Rollback の実装（実測）

| 項目         | 実装・実測                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| コマンド     | `scripts/ops/rollback.sh [--dry-run] <commit-sha>`（`pnpm ops:rollback`）                                                                                           |
| 動作         | 展開済みリリース（`releases/<sha>` に `.release-complete` と `release.env` があるもの）へ `current` を切り替え、API を再起動し、`/healthz` の commit 一致を確認する |
| DB           | **戻さない**（migration は additive のみ）。復元はバックアップから別DBへ                                                                                            |
| 自動戻し     | 切替後の healthz が失敗すると、`ops_switch_and_verify` が**前のリリースへ自動で戻す**。前のリリースでも失敗した場合は exit 2（手動復旧）                            |
| 終了コード   | 0=成功 / 1=失敗（切替前、または前のリリースへ戻した） / 2=戻せなかった                                                                                              |
| 排他         | `~/.local/share/mirai-sf/.ops.lock` の `flock`。release と rollback の同時実行を防ぐ                                                                                |
| worker       | rollback 時、`mirai-sf-worker.service` が active なら再起動する（**Staging 固定**）                                                                                 |
| dry-run 実測 | 2026-11-03 11:47 JST に `current: b2ae9e3… → 85fdcd9…（DB は戻しません）` を確認（変更なし）                                                                        |

**本番適用時の未対応点**:

1. `release.sh` / `rollback.sh` は `mirai-sf-worker.service` を固定で参照する。本番用 unit を別名にすると、Staging の worker を誤って再起動する。
2. `release.sh` は API unit 名 `mirai-sf-api.service` を固定で確認する。`MIRAI_SF_RESTART_HOOK` を設定すればこの確認はスキップされるが、hook の作成・検証が必要。
3. 本番用の `MIRAI_SF_HOME` / `MIRAI_SF_ENV_FILE` / `MIRAI_SF_HEALTH_URL` / `MIRAI_SF_RESTART_HOOK` を unit と運用に組み込む必要がある。
4. 承認ゲート・CI 成果物の照合はない（5.2）。

### 5.2 リリース・ロールバックの判断

| 事象                             | 判断                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| アプリの回帰（healthz は OK）    | 直前の展開済みリリースへ `rollback.sh`。DB は戻さない                                                |
| migration 後の不具合             | forward fix を優先。データ破損があればバックアップから別DBへ復元し、切替                             |
| healthz 失敗                     | 自動戻しが働く。戻せない場合は手動で前のリリースへ。DB は戻さない                                    |
| Access / Tunnel の設定変更が原因 | 変更前の設定へ戻す（変更履歴を記録）。Access を無効化して回避しない                                  |
| DB 破損・誤削除                  | 最新の検証済み dump から別DBへ復元 → `db:verify` → 切替。RTO 4 時間以内を目標                        |
| 本番全体の停止                   | API / Tunnel を停止し、Access を閉じ、原因と復旧見込みを記録。復旧は 3.3（DB）と 5.1（アプリ）の手順 |
| セキュリティインシデント         | 該当トークン・セッションを失効し、Access を絞り、監査ログを保全。必要なら本番を停止                  |

### 5.3 受入チェックリスト

#### 前提（Phase 1 完了条件）

- [ ] SC-02 の例外（ローカル PostgreSQL）が所有者・方針管理者により記録されている
- [ ] SC-03 の公開承認ルールが記録され、承認者が決まっている
- [ ] 本番ホスト名・DB 名・ポート・Access アプリ名が決まっている
- [ ] `prod.conf` が 0600 で作成され、`NODE_ENV=production` / `APP_ENV=production` である
- [ ] `ALLOW_SELF_APPROVAL=0`、`ALLOW_IMPORT=0`、`REQUIRE_ORIGIN_SECRET=1`、`COOKIE_SECURE=1`
- [ ] `SESSION_SECRET` / `ORIGIN_SHARED_SECRET` が本番専用の新規値
- [ ] `GITHUB_TOKEN` / `DEVLINE_GITHUB_TOKEN` / `ANTHROPIC_API_KEY` の分離方針が決まり、本番に必要なものだけが 0600 で置かれている
- [ ] Access JWT 検証（PR #27）が merge され、`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` が設定されている
- [ ] 本番 Access アプリ・ポリシー・DNS・Tunnel ingress が作成されている（未認証 302 を確認）
- [ ] 本番DB `mirai_sf_prod` と owner/app ロールが作成され、アプリが superuser 以外で接続する
- [ ] `postgresql` が boot 時有効化され、API unit が DB 起動後に起動する
- [ ] DB とバックアップが別ディスク/別領域にあり、オフサイト同期が設定されている
- [ ] RPO 1 時間を満たす方式（毎時 dump または WAL）が設定され、復元訓練で確認されている
- [ ] 外部監視とアラートが設定され、`/healthz` を Access 経由または別経路で監視できる
- [ ] `release.sh` / `rollback.sh` の本番用 env / restart hook / worker 名が検証されている
- [ ] 直前の展開済みリリースが rollback 先として存在する
- [ ] 監査アーカイブの timer 化と保存先が設定されている

#### デプロイ時

- [ ] 対象 SHA が `origin/main` に含まれ、CI の `quality` / `e2e` が success
- [ ] 破壊的 migration がない（`release.sh --dry-run` が exit 0）
- [ ] 事前バックアップが成功し、オフサイトにも同期されている
- [ ] ディスク空きが十分（例: 20% 以上）で、DB/バックアップの容量を確認
- [ ] 人間の公開承認が記録されている（SC-03）
- [ ] 作業者・立会者・作業時間・rollback 先・連絡先が記録されている
- [ ] `MIRAI_SF_HOME` / `MIRAI_SF_ENV_FILE` / `MIRAI_SF_HEALTH_URL` / `MIRAI_SF_RESTART_HOOK` を本番向けに設定
- [ ] 実行コマンドと結果（ログ）を保存

#### デプロイ後

- [ ] `/healthz` が `status=ok`、`db.ok=true`、`commit=<対象SHA>`、`environment=production`
- [ ] 公開 URL が Access のログインへ 302。認証後にトップ・依頼詳細・承認・注文書が表示
- [ ] 主要スモーク（登録→承認→注文書、API home/catalog/export）が成功
- [ ] `journalctl` に 5xx / ERROR がない（または既知の範囲）
- [ ] 監査ログのハッシュ連鎖が検証できる
- [ ] 自己承認が拒否される（`ALLOW_SELF_APPROVAL=0` の確認）
- [ ] バックアップ・監査アーカイブ・監視が動作している
- [ ] 30 分の重点監視（仕様案）を実施し、異常がない
- [ ] リリース記録（SHA・承認・実行者・時刻・backup・healthz・rollback 先・逸脱）を残す

#### Rollback 訓練（Phase 2 / 四半期）

- [ ] `rollback.sh --dry-run` で対象と現在の SHA を確認
- [ ] 実際に前のリリースへ切り替え、`/healthz` の commit が戻ることを確認
- [ ] DB が戻っていないこと（migration は additive）を確認
- [ ] 業務スモークが成功
- [ ] 再度 forward（最新リリース）へ戻す
- [ ] 訓練の所要時間を記録し、RTO 4 時間以内の見込みを更新

---

## 6. 費用概算

### 6.1 既存資源の範囲

| 項目                   | 現状（実測）                                                 | 案Aで追加が必要か   | 追加費用の見込み                                       |
| ---------------------- | ------------------------------------------------------------ | ------------------- | ------------------------------------------------------ |
| ホスト（CPU/RAM/disk） | 16 コア / 30 GiB / 9.1 TB + 936 GB。既存                     | 原則不要            | 0 円                                                   |
| OS / Node / PostgreSQL | Ubuntu 24.04.5 / Node 22 / PG 16.15。既存                    | 不要                | 0 円                                                   |
| ドメイン / DNS         | `mirai-dx-platform.com`（Cloudflare Free Website、$0）       | 不要                | 0 円                                                   |
| Cloudflare Tunnel      | `mirai-sf`（healthy、4 コネクション）                        | 既存を再利用可      | 0 円                                                   |
| Cloudflare Access      | アプリ 1 / ポリシー 1 / サービストークン 0。契約プラン未確認 | 本番アプリを追加    | 契約次第（**未確認**）                                 |
| PostgreSQL             | ローカル 16.15、333 DB / 7.1 GB 共用                         | 本番DB/ロールを追加 | 0 円（既存ホスト内）                                   |
| バックアップ保存       | ローカルのみ 2.1 MB                                          | オフサイト追加      | R2 無料枠 10 GB/月の範囲内なら 0 円（$0.015/GB-month） |
| 監視                   | 外部監視なし。systemd の `Restart=always` のみ               | 外部監視を追加      | 既存ツール/サービス次第（**未確認**）                  |
| 運用                   | 所有者 1 名                                                  | 手順・訓練・記録    | 人件費（金額は未算定）                                 |

**結論（案A）**: 月額の追加費用は**既存資源の範囲でほぼ 0 円**。オフサイトは R2 の無料枠（10 GB/月）に収まる見込み。追加で発生しうるのは、UPS・監視サービス・バックアップ先の容量・2 人目の運用体制・外部専門家のレビューなど。**これらは見積未取得**。

### 6.2 案B / 案C の追加費用

| 項目                      | 案B（Workers + Neon）                                                                                                  | 案C（別ホスト/クラウド）                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| アプリ実行                | Workers Paid **最低 $5/月**（Cloudflare 公式、2026-10-02 更新）                                                        | 新ホスト/VM の月額（**見積未取得**）               |
| DB                        | Neon Launch 目安 **約 $15/月**（小規模DB、公式 2026-10-31 更新）。従量: compute $0.106/CU-hour、storage $0.35/GB-month | ローカルPGなら 0 円。マネージドDBなら参考 $15/月〜 |
| Access                    | 契約・シート数は**未確認**（Billing Read 権限なし）                                                                    | 同左                                               |
| バックアップ / オフサイト | Neon の PITR/履歴 + 追加ストレージ。R2 等                                                                              | バックアップストレージ + オフサイト                |
| 移行工数                  | **大**（Fastify/DB/ファイル/Docker worker/メール/監査の移植）                                                          | 中（構築・移行・運用の立ち上げ）                   |
| 運用                      | Cloudflare 中心。ベンダー依存                                                                                          | ホスト 2 台の patching・監視・障害対応             |
| 月額の目安                | **$20/月以上 + 移植工数**（Access 契約・為替・税は別）                                                                 | **見積未取得 + 運用工数**                          |

**注意**: 上記は公開価格の参照であり、契約条件・為替・税・割引・シート数により変わる。**見積ではない**。Access の契約プランは API 権限不足で取得できていない。

### 6.3 費用対効果の判断

- 案Aは「既存の投資（ホスト・ドメイン・Tunnel・Access・運用知識）」を最大限使う。追加費用はほぼ 0 円で、本番までの期間が最短。
- ただし可用性 99.5% を要件にする場合、案Aは単一障害点の解消に追加投資（UPS、冗長回線、予備ホスト、監視）が必要になり、結果として案Cに近づく。**「0 円で 99.5%」は成立しない**。
- 案Bは組織方針に適合するが、devline worker のスコープ変更と大規模な移植を伴う。費用は月額だけでなく**機会費用（移植期間中の機能停止）**が大きい。
- 案Cは可用性・分離の要件に応じて段階的に投資できる。まず案Aで本番を立ち上げ、可用性の実測後に案Cへ移る道が現実的。

---

## 7. 本番の統制要件

### 7.1 職務分離（自己承認拒否）

| 要件                                 | 実装・実測                                                                                                               | 状態                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 自分で自分を承認できない（ERR-105）  | `src/api/service.ts:682` が `allowSelfApproval=false` のとき `Errors.selfApproval()`（403 ERR-105）を返す                | 実装済み                                                                                                                                       |
| 本番で自己承認を無効化               | `ALLOW_SELF_APPROVAL` の既定は **`1`**（`src/api/config.ts:138`）。Staging の生成値も `1`（`scripts/setup-preview.mjs`） | **本番は `0` を必須**。既定のままでは満たさない                                                                                                |
| 複数ユーザー・役割の分離             | 1 ユーザー・3 役の切替（L-01）。Entra ID SSO は未実装                                                                    | **未達**                                                                                                                                       |
| Access ログインの管理者自動付与      | `accessLogin` の未登録利用者の扱い（`src/api/auth.ts`）。旧実装は `is_admin=true`・3 役で自動作成した                    | **是正済み（2026-11-06）**: 既定は自動作成なし（401）。`ACCESS_AUTO_PROVISION=1` の開発・テスト opt-in でも `is_admin=false`・`requester` のみ |
| 承認とマージの分離（製品 PR）        | この repo は SC-01 により品質ゲートで自動マージ。製品 PR の人の SHA 承認は未実装（FR-39）                                | **未達（本番の製品ライン）**                                                                                                                   |
| 本番公開の承認（G4 / FR-40 / BR-08） | 仕様は「マージとは別のリスク判断」。実装はない。SC-03 未決                                                               | **未実装**                                                                                                                                     |

**結論**: コード上の ERR-105 はあるが、**本番の職務分離は満たしていない**。最低限、`ALLOW_SELF_APPROVAL=0`、複数ユーザー/ロールの設計、公開承認の記録が必要（Access の管理者自動付与の廃止は 2026-11-06 に対応済み）。

### 7.2 Required Checks（品質ゲート）

| 要件                           | 実測                                                                                                                                                                                                                                          | 状態                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| main への merge に必須チェック | `quality` / `e2e`、`strict=true`、`enforce_admins=true`、force push 禁止、削除禁止、会話解決必須                                                                                                                                              | **実装済み**                                                      |
| レビュー必須                   | required pull request reviews は未設定。所有者 1 名では自分の PR を承認できないため（SC-01）                                                                                                                                                  | 意図的に未設定。本番の承認は別の仕組みで担保する                  |
| CODEOWNERS                     | なし                                                                                                                                                                                                                                          | 未実装                                                            |
| CI の内容                      | typecheck / lint / unit / migration（空DB・冪等）/ seed / db:verify / integration / build / secret scan / e2e / docker                                                                                                                        | 実装済み                                                          |
| 本番リリースのゲート           | exact-main CI ゲートは実装済み（PR #92。`prod-release.sh` → `release.sh` が `check-release-ci.mjs` で push/main `ci.yml` の最新 attempt と quality/e2e/docker の成功を必須にする。bypass なし）。承認ゲート・成果物ハッシュの照合は確認しない | CI ゲートは**実装済み**。承認ゲート・成果物同一性照合は**未実装** |
| 成果物の同一性                 | `release.sh` はホスト上で `pnpm install` / `pnpm build` を再実行する。CI で検査した成果物をそのまま配備する仕様（4-9）とは異なる                                                                                                              | **未実装**。当面は「再ビルド」のリスクを受容し、記録する          |
| Actions の権限                 | `allowed_actions=all`、SHA pinning なし                                                                                                                                                                                                       | 改善余地                                                          |

**結論**: main の品質ゲートは機能している。本番の「どのビルドを出すか」「承認したか」を守るゲートはない。SC-03 の実装まで、人間がリリース時に確認する。

### 7.3 監査

| 要件               | 実装・実測                                                                                                  | 状態       |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ---------- |
| 監査ログの追記のみ | `audit_log_append_only` トリガ（UPDATE/DELETE 拒否）。`TRUNCATE` / `DROP` / trigger 無効化は防げない（M-5） | 部分       |
| ハッシュ連鎖       | あり。`verifyAuditChain` と `db:verify` で検証                                                              | 実装済み   |
| 監査の閲覧制限     | `/api/audit-logs` と CSV は管理者のみ（`src/api/app.ts:498,538`）                                           | 実装済み   |
| 監査のエクスポート | `/api/audit-logs.csv` は管理者のみ。`reset-demo` は本番で拒否                                               | 実装済み   |
| 監査アーカイブ     | `scripts/audit-archive.ts`（365 日）はあるが **timer なし**。最終ファイル 2026-10-28                        | **未運用** |
| ログの保持         | journald は現在のブートのみ（523.7 MB）。保持設定は未確認                                                   | **不足**   |
| 改ざんの完全防止   | DB owner はトリガを無効化できる。外部への先頭ハッシュ保存は未実装                                           | 未達       |
| 監査の定期レビュー | 手順はあるが、本番の定期レビューは未定                                                                      | 未定       |

**本番の要件**: アーカイブの timer 化、オフサイトの不変ストレージ、ハッシュ先頭の外部保存、監査レビューの月次実施、DB owner とアプリの分離、保持年数（Q-09）の決定。

### 7.4 Access の範囲

| 項目             | 実測                                               | 本番の要件                                                |
| ---------------- | -------------------------------------------------- | --------------------------------------------------------- |
| 保護対象         | `sf.mirai-dx-platform.com` のみ                    | 本番ホスト名を追加。Staging と別アプリ・別ポリシー        |
| セッション       | 12 時間                                            | 12 時間以下。重要操作は再認証を検討                       |
| 許可             | `email_domain = mirai-const.co.jp` の 1 ポリシー   | 特定アドレスまたは IdP グループへ絞る。管理者行を明示     |
| サービストークン | 0 件                                               | 監視・自動 E2E 用に発行（権限追加が必要）                 |
| MFA / SSO        | ワンタイムパスワード（メール）。Entra ID SSO なし  | 本番の認証方式を決定（§8）。NFR-38 の MFA 要件を確認      |
| JWT 検証         | 未実装（ヘッダ信頼）。PR #27 が OPEN / CONFLICTING | merge して `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` を設定     |
| Origin           | `127.0.0.1:8782` のみ。Tunnel 経由                 | 本番も `127.0.0.1:<port>` のみ。`REQUIRE_ORIGIN_SECRET=1` |
| 監査             | Access のログは Cloudflare 側                      | 本番の Access ログの保存期間・エクスポートを確認          |

**結論**: Access は「公開経路の入口」として機能しているが、本番の認証・認可としては不足（JWT 未検証、SSO なし、管理者自動付与、ポリシーがドメイン全体）。**本番前に是正する。**

### 7.5 統制の実装状況サマリ

| 統制                    | 実装状況 | 本番前に必要なこと                                                 |
| ----------------------- | -------- | ------------------------------------------------------------------ |
| 自己承認拒否（ERR-105） | 部分     | `ALLOW_SELF_APPROVAL=0`、Access 自動管理者の廃止、SSO/複数ユーザー |
| Required Checks         | 実装済み | 本番リリースのゲートを追加（承認・CI 成果物）                      |
| 職務分離（製品ライン）  | 未実装   | FR-39 / G4 の実装または人手の承認記録                              |
| 監査（追記・ハッシュ）  | 実装済み | アーカイブ timer、オフサイト、保持年数、owner 分離                 |
| 監査（レビュー・保存）  | 未運用   | 月次レビュー、外部保存、journal 保持                               |
| Access の認証・認可     | 部分     | JWT 検証、ポリシー絞り込み、SSO/MFA、サービストークン              |
| 本番公開承認            | 未実装   | SC-03 の決定と記録、リリース手順への組込み                         |
| バックアップ・復元      | 部分     | オフサイト、RPO 1 時間、本番ドリル                                 |
| 監視・アラート          | 未実装   | 外部監視、アラート、オンコール                                     |
| 変更管理（FR-46）       | 未実装   | 本番変更の承認・記録の仕組み                                       |

---

## 8. 未決事項（人間の判断が必要）

以下は**所有者（または指定された決定者）の判断**が必要である。推奨を添えるが、本書は決定しない。**これらが決まるまで本番環境を作らない。**

1. **本番ホスト名を新設してよいか Y/N**（推奨: Y。例 `sf-prod.mirai-dx-platform.com`。Staging と分離）
2. **本番DB名を `mirai_sf_prod` としてよいか Y/N**（推奨: Y）
3. **組織方針 §4 の例外（ローカル PostgreSQL）を記録してよいか Y/N**（SC-02。推奨: Y。記録がなければ案Aは方針違反）
4. **本番公開は常に人の承認を必須とするか Y/N**（SC-03。推奨: Y）
5. **本番を既存ホストと同一に置いてよいか Y/N**（案A。単一障害点・同居サービスの影響を受容するか。推奨: 条件付き Y）
6. **RPO の目標をどうするか（番号選択）**: 1) 1 時間（毎時 dump を追加） 2) 1 時間（WAL アーカイブ/PITR を実装） 3) 24 時間（日次 dump のまま。仕様目標を緩和し、逸脱を記録）
7. **オフサイトの保存先（番号選択）**: 1) Cloudflare R2 2) 社内 NAS 3) 別クラウド 4) 別ホスト
8. **本番の認証方式（番号選択）**: 1) Cloudflare Access のワンタイムパスワード（現行） 2) Entra ID SSO（未実装） 3) Access + SSO の併用
9. **本番の職務分離の進め方（番号選択）**: 1) 複数ユーザー + 自己承認禁止 + 管理者自動付与の廃止を先に実装 2) 1 ユーザーで開始し、例外と補償統制を記録
10. **本番で devline worker（実 AI / Docker）を動かすか Y/N**（推奨: 当面 N。動かすなら専用ホスト/リソース分離とトークン分離が前提）
11. **本番でメール通知を有効にするか Y/N**（`MAIL_MODE`。推奨: 当面 N（off）。有効化するなら SMTP と宛先マスタの整備）
12. **稼働率 99.5%（平日 8:00–19:00、案）を本番の要件にするか Y/N**（推奨: 要件にするなら案Cへ。案Aなら受容する範囲を明記）
13. **監査・データの保持年数（番号選択）**: 1) 7 年（仕様案） 2) 5 年 3) 10 年 4) 未定（当面は削除しない）
14. **本番の公開承認者（Q-21）を 1 名指定するか Y/N**（推奨: Y。個人名は本書に書かず、決定後に記録）
15. **本番切替の希望時期と凍結期間 Y/N**（決めるまで日程を確定しない）

### 8.1 決定（2026-11-03 所有者の回答）

所有者（公開承認者）が 2026-11-03 に回答した。**未回答の項目は「推奨案で準備」とし、公開（DNS 作成）の直前に再確認する。**

| #   | 決定                                                                          | 状態                                     |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | **Y**: 本番ホスト名 `sf-prod.mirai-dx-platform.com` を新設する                | 決定                                     |
| 2   | **Y**: 本番DB名は `mirai_sf_prod`                                             | 推奨案（#1/#3 と一体。公開前に再確認）   |
| 3   | **Y**: 組織方針 §4 の例外（ローカル PostgreSQL）を記録する                    | 決定（SC-02 に記録）                     |
| 4   | **Y**: 本番公開は常に人の承認を必須とする                                     | 決定（SC-03 に記録）                     |
| 5   | 案A（既存ホストと同一）                                                       | 推奨案（明示の回答なし。公開前に再確認） |
| 6   | **1**: RPO 1 時間（毎時 dump を追加）                                         | 決定                                     |
| 7   | **1**: オフサイトは Cloudflare R2（非公開バケット）                           | 決定                                     |
| 8   | 1（Cloudflare Access のワンタイムパスワード）                                 | 推奨案（公開前に再確認）                 |
| 9   | 1（複数ユーザー・自己承認禁止。実装は #66。管理者の自動付与は本番で行わない） | 推奨案（公開前に再確認）                 |
| 10  | N（本番では devline worker を動かさない。`prod-release` は worker=none）      | 推奨案（公開前に再確認）                 |
| 11  | N（`MAIL_MODE=off`）                                                          | 推奨案（公開前に再確認）                 |
| 12  | 要件化しない（案Aの best-effort。逸脱は記録）                                 | 推奨案（公開前に再確認）                 |
| 13  | 4（未定。当面は削除しない）                                                   | 推奨案（公開前に再確認）                 |
| 14  | Y（公開承認者は所有者。個人名は本書に書かない）                               | 推奨案（公開前に再確認）                 |
| 15  | 2026-11-03 着手・凍結期間なし                                                 | 決定（凍結の指示は受けていない）         |

- 「公開前に再確認」の項目は、`02-runbook.md` の 8 章（公開）の直前に 1 行で確認する。**それまでは推奨案で構築し、公開はしない。**
- 組織方針 `/etc/claude-code/CLAUDE.md` は root 所有で AI からは書き換えられない。例外はこの repo の本 ADR と SC-02 に記録し、方針ファイルへの追記は所有者が行う（残課題）。

### 8.2 決定（2026-11-05 所有者の回答）

所有者が 2026-11-05 に、AI が示した選択肢（Q1〜Q4）へ**回答番号**で答えた。承認は所有者の回答番号であり、本節は AI（Lead 配下）が代筆した記録である。回答の趣旨を変えずに記録する。

| #   | 回答  | 決定                                                                                                                                                                                                                                                                                                                                             | 状態                                      |
| --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Q1  | **1** | `Software-Factory-Sandbox` の main 保護（ブランチ保護・必須チェック）は**所有者が GitHub で設定する**。設定後に AI が `pnpm ops:repo-check Kensan196948G/Software-Factory-Sandbox` で再確認し、結果を記録する（下記の確認範囲）                                                                                                                  | 所有者の設定待ち（AI は設定を変更しない） |
| Q2  | **3** | 本番は**技術受入のみで運用を開始する**。人間 OTP 後の別人 2 名による業務受入（`03` §4 のケース S / B）は未実施のまま開始する                                                                                                                                                                                                                     | 決定（範囲は下記）                        |
| Q3  | **1** | リハーサル環境の DB `mirai_sf_prodr` と `~/.local/share/mirai-sf-prodr` は**残置**する（削除しない）。リハーサル用 API のプロセスは 2026-11-05 に停止済み（`11-production-release-20261105.md`）                                                                                                                                                 | 決定（残置。削除は別途の判断）            |
| Q4  | **1** | 運用保証を 10 ステップで設計・実証する。選択肢 1 の文言「設定変更が必要なものは都度 Y/N で確認します」に従い、設定変更はステップごとに所有者の Y/N を取る。10 ステップと各成功条件は [`15-ops-assurance-plan-20261105.md`](15-ops-assurance-plan-20261105.md) で追跡する。ここでの「運用保証」は可用性の保証ではなく、保証活動と証跡の計画である | 決定（各ステップの設定変更は都度 Y/N）    |

- **Q2 の範囲**: 「人間 OTP 後の別人 2 名による業務受入を実施せず、技術受入のみで本番運用を開始する」ことだけである。
- **業務受入の未実施と L-01 / L-02 は別の事柄**である。業務受入の未実施は、ケース S / B（自己承認の拒否・別人承認）を本番で実地に確かめていないという事実を指す。L-01 / L-02 は製品の制限で、正本は `docs/limitations.md`。これらの制限は Q2 の決定とは関係なく**残存し続ける**（業務受入を実施しても解消しない）。
- **業務受入は将来実施できる状態を保つ**。`03-business-acceptance-and-operations.md` §2〜§4 の手順と記録票は削除せず維持し、実施したら同書の記録票へ追記する。
- **Q1 の確認範囲**: `pnpm ops:repo-check Kensan196948G/Software-Factory-Sandbox`（`scripts/ops/repo-onboarding-check.mjs`、読取り専用）で確かめられるのは、main に**保護が存在し必須チェック（required_status_checks）があること**までである。直接 push の禁止・force push の禁止・管理者への適用（enforce_admins）は、別途 `gh api repos/Kensan196948G/Software-Factory-Sandbox/branches/main/protection`（GET のみ）を読み、`allow_force_pushes`・`enforce_admins`・PR 必須の各項目で確認する。AI は Sandbox の保護設定・台帳・`DEVLINE_TARGET_REPOS` を変更しない。
- Q3 の残置物は運用対象外（`07-slo-and-measurement.md` の参考値）であり、本番の監視・バックアップ・SLO の対象に含めない。

---

## 9. SC-02 / SC-03 の結論案

### 9.1 SC-02（本番公開の経路 / 本番基盤）の結論案

**結論案: 候補1（組織方針に例外を追記し、ローカル PostgreSQL を正式とする）を推奨。**

- 本番は案A（同一ホスト + `mirai_sf_prod` + 本番ホスト名 + 既存 Tunnel/Access）とする。
- 組織方針 §4（Cloudflare Pages/Workers + Neon）は、**所有者と方針管理者が例外を記録する**。記録先は `docs/devline/assessment/source-conflicts.md` の SC-02 と、組織方針の該当箇所。
- 理由:
  1. 所有者の 2026-10-31 の決定（Neon を使わずローカル PostgreSQL）と一致する。
  2. devline worker が Docker を必要とし、Workers では中核機能を維持できない。
  3. 既存のリリース・バックアップ・復元・rollback の実装をそのまま使える。
  4. 追加費用がほぼ 0 円で、最短で本番を立ち上げられる。
- 条件: 可用性 99.5% を要件にする場合は案Aでは不足する。その場合は案C（別ホスト + マネージドDB）を再検討する。案Bはスコープ変更（devline worker の分離/廃止）を伴う場合のみ。
- **記録がない限り、本番を対象とする作業を開始しない**（現行の SC-02 の扱いを維持）。

### 9.2 SC-03（本番配備の自律実行 / 人の公開承認）の結論案

**結論案: 候補2（この repo のアプリも含め、本番公開は常に人の公開承認を取る）を推奨。**

- マージの承認と公開の承認は**別のリスク判断**である（仕様 4-9、G4、FR-40、BR-08）。この repo の SC-01（品質ゲートで自動マージ）は「main に入れる」判断であり、本番公開の判断ではない。
- 所有者 1 名の体制でも、**誰が・いつ・どの SHA / 成果物を・なぜ公開したか**を記録する必要がある（インシデント時の説明責任）。
- 現行の `release.sh` には承認ゲートも CI 成果物の照合もない。**実装が終わるまで、本番の release / rollback は人間が実行し、AI は準備・検証・記録のみを行う。**
- 承認の記録方法（案）:
  - 対象: commit SHA、成果物（ビルド）のハッシュ、環境（production）、変更内容、リスク、rollback 先。
  - 承認者: 所有者または委任された公開承認者（Q-21）。
  - 記録先: PR / Issue のコメント、またはリリース記録（DB/ファイル）。**新しいコミット・成果物の変更で承認は失効**する。
  - 緊急時: 事後の二重承認と記録（仕様 4-9 の例外に準拠）。
- 候補1（この repo は §4 に従い自律配備）を採る場合でも、**初回の本番切替と migration は人間の立会いを必須**とし、自動化は段階的に導入することを推奨する。
- **SC-03 が決まるまで本番デプロイを行わない**（現行の扱いを維持）。

### 9.3 決定の記録

- SC-02 / SC-03 の決定は、`docs/devline/assessment/source-conflicts.md` の該当節に日付・決定者・理由とともに追記する。
- 本書 §8 の決定も同じ場所または本書の改訂版に記録する。
- 決定後に `docs/production/` へ運用手順（`01-runbook.md` 等）を追加する。**本書は決定文書であり、手順書ではない。**

---

## 10. 未確認事項

以下は実測できていない、または判断していない。**推測で埋めない。**

| #    | 未確認事項                                                                               | 理由・制約                                                               |
| ---- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| U-1  | Cloudflare Zero Trust の契約プラン・シート数                                             | `GET /accounts/{id}/subscriptions` が 403（Billing Read なし）           |
| U-2  | `preview.conf` の実際の値（`GITHUB_TOKEN` の有無・権限、`ALLOW_SELF_APPROVAL` の実値等） | 秘密を含むため本書では読まない。生成スクリプトの既定値のみ確認           |
| U-3  | 本番の復元時間（RTO 全体）・オフサイトからの取得時間                                     | 本番DBが未作成。Phase 2 で実測する                                       |
| U-4  | 本番の可用性（99.5% を満たせるか）                                                       | 単一ホストの実測なし。監視も未設定                                       |
| U-5  | journald の保持設定（なぜ現在のブートだけか）                                            | 設定ファイルの確認が不十分                                               |
| U-6  | 本番の負荷（同時 100 名、P95 目標）                                                      | 負荷試験は未実施                                                         |
| U-7  | Cloudflare Access の実 JWT での検証                                                      | PR #27 が未 merge。実 Access の発行トークンでは未検証（PR 本文）         |
| U-8  | Branch protection の適用者・適用日時                                                     | 現在の設定は API で確認したが、変更履歴は未確認                          |
| U-9  | 本番のデータ分類・保持年数（Q-09）・法的要件                                             | 未決。§8 で判断                                                          |
| U-10 | 本番ホストの電源・回線・UPS の状況                                                       | 未確認。可用性の前提                                                     |
| U-11 | Access のメール到達性・OTP の運用                                                        | 実測なし。外部要因                                                       |
| U-12 | 本番用の見積（案C のホスト/VM、監視、バックアップ）                                      | 未取得                                                                   |
| U-13 | 本番で devline worker を動かす場合のリソース・隔離・予算                                 | 未決。§8                                                                 |
| U-14 | `healthcheck.json` を書き込む主体（2026-11-03 11:43 更新）                               | 書き込み元の unit/スクリプトを特定できていない。監視の常設とは断定しない |
| U-15 | PostgreSQL の LAN 経由の到達性（`mirai_sf` 向けの pg_hba 行がないこと）                  | pg_hba を sudo で読んだ範囲。実接続試験はしていない                      |

---

## 11. 付録A: 実測コマンドと主要出力

実行日時: 2026-11-03 11:39–11:48 JST。すべて読み取り、または `--dry-run`。

| #   | 目的                  | コマンド（要約）                                                                                                           | 主要出力（要約）                                                                           |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | リポジトリ状態        | `git status --short --branch` / `git log --oneline -5`                                                                     | `main...origin/main`、`b2ae9e3`                                                            |
| 2   | 固定リリース          | `readlink -f ~/.local/share/mirai-sf/current` / `cat current/release.env`                                                  | `releases/b2ae9e32…`、`COMMIT_SHA=b2ae9e32…`                                               |
| 3   | リリース一覧          | `ls -la ~/.local/share/mirai-sf/releases/` / `du -sh`                                                                      | 10 件、604 MB、現行 423 MB                                                                 |
| 4   | systemd units         | `systemctl --user list-units` / `cat` / `systemctl --user show -p ExecMainStartTimestamp`                                  | 1.3 の表。backup 1 秒、drill 31 秒、reminders 1 秒、すべて success                         |
| 5   | unit テンプレート一致 | `diff deploy/systemd/mirai-sf-* ~/.config/systemd/user/mirai-sf-*`                                                         | 7 ファイルすべて差分なし                                                                   |
| 6   | 待受                  | `ss -ltnp`                                                                                                                 | `127.0.0.1:8782`、`127.0.0.1:5432`、`192.168.0.185:5432`                                   |
| 7   | healthz               | `curl -fsS http://127.0.0.1:8782/healthz`                                                                                  | 1.6 の JSON（status ok、commit 一致、db ok 1.4ms、environment staging）                    |
| 8   | 公開 URL              | `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' https://sf.mirai-dx-platform.com/`                                | 302 → Access ログイン。`/healthz` も 302                                                   |
| 9   | Tunnel / Access / DNS | Cloudflare API（`GET /accounts/{id}/cfd_tunnel`、`/access/apps`、`/access/apps/{id}/policies`、`/zones/{id}/dns_records`） | 1.4 の表                                                                                   |
| 10  | DB                    | `psql -Atc "…"`（version / pg_database / schema_migrations / audit_log / pg_roles / archive_mode）                         | 1.5 の表。333 DB / 7,137 MB、mirai_sf 10 MB、12 migrations、audit 142 行、archive off      |
| 11  | バックアップ          | `ls -la ~/.local/state/mirai-sf/backups/` / `cat …manifest.tsv`                                                            | 14 件 + 手動 1 件、180,231 bytes、28 テーブル、audit tip あり                              |
| 12  | 監査アーカイブ        | `ls -la ~/.local/state/mirai-sf/audit/`                                                                                    | `audit-2026-10-28.jsonl.gz` のみ（42 KB）                                                  |
| 13  | journal               | `journalctl --disk-usage` / `journalctl --list-boots`                                                                      | 523.7 MB、現在のブートのみ                                                                 |
| 14  | ホスト                | `hostname` / `nproc` / `free -h` / `df -h` / `uptime` / `last reboot`                                                      | 1.7 の表                                                                                   |
| 15  | GitHub 統制           | `gh api repos/…/branches/main/protection` / `gh run list` / `gh pr view 27`                                                | 1.8 の表。quality/e2e、strict、enforce_admins、PR #27 OPEN/CONFLICTING                     |
| 16  | 設定の権限            | `ls -la ~/.config/mirai-sf/` / `ls -l ~/.cloudflared/<uuid>.json`                                                          | preview.conf / devline-secrets.env / local.json 0600、Tunnel 資格情報 0400、prod.conf なし |
| 17  | 本番成果物の不在      | `psql … LIKE '%prod%'` / `ls ~/.config/systemd/user` / `grep mirai-sf` / DNS API                                           | 本番DB・unit・conf・DNS なし                                                               |
| 18  | release dry-run       | `pnpm ops:release --dry-run b2ae9e3…`                                                                                      | 未適用 migration なし、unit は current 参照、current は b2ae9e3、計画のみ（exit 0）        |
| 19  | rollback dry-run      | `pnpm ops:rollback --dry-run 85fdcd9…`                                                                                     | `current: b2ae9e3… → 85fdcd9…（DB は戻しません）`（exit 0）                                |

**実行しなかったこと**: `systemctl start/stop/restart`、DB の作成・変更・削除、Cloudflare の設定変更、本番ホスト名/DNS の作成、`pg_dump`/`pg_restore` の新規実行、負荷試験。これらは本番準備の承認後に行う。

---

## 12. 変更履歴

| 日付       | 版  | 変更                                                                                                                              | 変更者     |
| ---------- | --- | --------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 2026-11-03 | 1.0 | 初版。Staging の実測、案A/B/C の比較、DB・秘密・復旧・費用・統制・未決・SC-02/03 の結論案                                         | prodarch   |
| 2026-11-05 | 1.1 | §8.2 に 2026-11-05 所有者決定（Q1〜Q4。承認は所有者の回答番号、AI 代筆）を追記。10 ステップは `15-ops-assurance-plan-20261105.md` | AI（代筆） |

---

**付記**: 本書は提案であり、所有者の承認を代替しない。AGENTS.md §2-6（本番・Cloudflare Production・課金・契約・権限の重大変更は承認が必要）に従い、本番環境の作成・変更は承認後に行う。
