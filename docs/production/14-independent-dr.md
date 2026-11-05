# 14. オフサイトだけからの独立復旧（ホスト喪失を想定）

状態: **道具と手順を用意した段階**（2026-11-05）。別ホストでの通し訓練は**未実施**（Lead が行う）。
背景: `offsite-drill.mjs` はローカルの送信記録 `*.dump.r2.json` を起点にする。ホストを失うとこの記録も無くなる（`10-release-verification-20261104.md` §10）。
道具: `scripts/ops/offsite-recover.mjs`（実行部）と `scripts/ops/lib/offsite-recover-core.mjs`（解析・選択・照合の純粋ロジック）。送信記録を使わず、R2 の中身だけから最新の dump と同名の manifest を選び、整合を確かめてから `restore-drill.sh` に渡す。

## 1. R2 の一覧を取る方法（2026-11-05 に確認）

| 方法                                                      | 可否                                                                                                                                            | 認証                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `wrangler r2 object list`                                 | **無い**（wrangler 4.122.0 の `r2 object` は get / put / delete だけ。公式の Wrangler コマンド一覧と一致）                                      | －                                                                                |
| REST `GET /accounts/{id}/r2/buckets/{bucket}/objects`     | **可**（prefix・cursor・per_page=1000。最終ページは `result_info` が付かない＝実測。満杯なら `start_after` で 0 件を確認）                      | API トークン。**Workers R2 Storage Bucket Item Read**（読取り・一覧だけ）で足りる |
| REST `GET .../objects/{key}`                              | **可**（本体をそのまま返す）                                                                                                                    | 同上                                                                              |
| キー推定（`<prefix>/<db>-YYYYMMDDTHHMMSSZ.manifest.tsv`） | **可（代替）**。先に `r2 bucket info` でバケットを確認（`object get` はバケットが無くても「キーが無い」と返すため）。「無い」以外の失敗で即停止 | wrangler の OAuth                                                                 |

- 一覧の試行（読取りのみ）: prefix `mirai_sf_prod/` に 134 件（dump 67 + manifest 67、2026-11-03〜11-05）。etag はすべて 32 桁 hex（単一パート＝MD5）で、ローカル同名ファイルの MD5 と一致した。
- wrangler の OAuth は REST の一覧には使わない（OAuth のトークンを取り出してスクリプトに渡す運用は作らない）。一覧は**読取り専用のスコープ付きトークン**で行い、書込み権限を持たせない。

## 2. 使い方

```bash
# A. 一覧（推奨）。CLOUDFLARE_ACCOUNT_ID と MIRAI_SF_R2_READ_TOKEN（読取り専用）を環境に置く
node scripts/ops/with-env.mjs scripts/ops/offsite-recover.mjs --verify-only   # 取得と整合だけ
node scripts/ops/with-env.mjs scripts/ops/offsite-recover.mjs                 # 一時DBへの復元訓練まで
# B. 一覧が使えないとき（wrangler login 済み）。窓は既定で直近 1 時間・上限 3601 件
node scripts/ops/offsite-recover.mjs --source guess --verify-only --from 2026-11-05T07:00:00Z --to 2026-11-05T08:00:00Z
# 本番 DB の作り直しに使うファイルを残す（0700 / 0600、既存なら上書きしない）
node scripts/ops/offsite-recover.mjs --verify-only --out ~/recovered
```

- 選び方: `<prefix>/<db>-<時刻>.dump` と同名 `.manifest.tsv` が**両方ある**最新。A は manifest の無い dump（送信途中）・サイズ 0・未来の時刻（10 分超）を飛ばす。**A・B とも**、選んだ組が未来（10 分超）または 24 時間より古ければ失敗（`--max-age-hours`、0〜2160。B は古いものへ黙って進まない）。
- 入力の検査: 読取りトークンは可視 ASCII 20〜512 文字だけ（改行・空白は送る前に拒否。fetch の例外は種別だけを出す）。`MIRAI_SF_R2_PREFIX` の空・`.`・`..` のセグメントは拒否し、組み立てた URL が `/accounts/<id>/r2/buckets/<bucket>/objects` の下にあることを確かめる。`--from` / `--to` は `Z` か `±HH:MM`（±14:00 まで）付きの実在する日時だけ。`--out` は無ければ 0700 で新規作成、既存なら本人所有で group/other に書込み不可のディレクトリだけを受け（シンボリックリンクは拒否）権限は変えない。親ディレクトリも本人所有か root 所有で、group/other 書込み可能なら sticky 付き（/tmp 型）に限る。
- 失敗の表示: wrangler の stderr 本文は出さず、`kind`（not_found / bucket_not_found / auth / rate_limited / network / signal / unknown）・終了コード・HTTP 状態・Cloudflare のエラーコードだけを出す（アカウント ID やトークン様の文字列を出さない）。`--max-probes` は 1〜86401。子は独立したプロセスグループで起動し、Ctrl-C / SIGTERM の 1 回目はそのグループへ 1 回だけ転送、2 回目で SIGKILL。一時領域を消して 130 / 143 で終わる。
- 推定の窓を広げすぎない: 1 件およそ 3.5 秒（wrangler の起動を含む）。1 時間の窓を全部試すと最悪 3.5 時間。**時刻が分かるなら窓を絞る**。毎時のバックアップ（55 分間隔）なので、直近 1 時間に通常 1 件ある。
- 実測（読取りのみ）: B で `--from 07:50:00Z --to 07:50:30Z` → 9 回目で `20261105T075022Z` を発見、TOC 28 テーブル＝manifest 28 テーブル、取得した dump / manifest の SHA-256 はローカル送信記録と一致（33.6 秒）。A は読取りトークンが未発行のため未実行（一覧そのものは REST で確認済み）。

## 3. 確かめること（ローカルのハッシュ記録の代わり）と保証の弱さ

| 確認                                                                                                | 一覧（A） | 推定（B） |
| --------------------------------------------------------------------------------------------------- | --------- | --------- |
| 取得サイズ＝一覧の size                                                                             | ○         | ×         |
| MD5＝一覧の etag（単一パート）。etag 欠落・不明形は失敗、`<hex>-N` のマルチパートだけ照合不能と明示 | ○         | ×         |
| manifest の形（`#audit_tip` ＋ 64 桁 hex か空、テーブル名の昇順・重複なし・件数は整数）             | ○         | ○         |
| `pg_restore --list` が通る。TOC の `TABLE DATA public` が重複なしで manifest のテーブル集合と一致   | ○         | ○         |
| 一時DBへ復元し、件数・監査ログ末尾ハッシュが manifest と完全一致、`db:verify`（連鎖）               | ○         | ○         |

- **弱さ 1（同じ場所の改ざん）**: 基準は R2 自身の中にある。dump と manifest を**両方**書き換えられる者（R2 の書込み権限）がいれば、整合した偽物を作れる。ローカル記録の SHA-256 は「送った時点の値」という外部の基準だったが、それが無い。etag は R2 が計算する値で、置き換え後の内容と一致してしまう。
- **弱さ 2（取り違え）**: manifest は件数と監査ログ末尾ハッシュだけ。dump の中身全体のハッシュは持たない。ただし監査ログはハッシュ連鎖で、`db:verify` が連鎖全体を検算するため、監査ログの改ざんは検出できる。業務テーブルの内容の改ざんは件数が同じなら検出できない。
- **弱さ 3（推定）**: B はサイズと etag を照合できない（wrangler の get は値を返さない）。
- 補う案（未実施・所有者判断）: バケットに **Bucket Lock**（一定期間の削除・上書き禁止）をかける／送信時の SHA-256 を**別の場所**（例: 別アカウントの保管先や紙の運用記録）にも残す。どちらも設定変更なので本 PR ではしない。

## 4. 別ホストで必要なもの

| もの                                  | 入手先・注意                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Node 22 以上・pnpm                    | `restore-drill.sh` は Node 22 を要求（`ops_use_node`）                                                           |
| PostgreSQL 16（サーバとクライアント） | `pg_restore` 16 と復元先の空 DB。drill は一時DB `mirai_sf_drill_*` を作って消す                                  |
| このリポジトリ                        | GitHub `Kensan196948G/Software-Factory`（private）を読める GitHub 資格。`pnpm install`（drill は tsx を使う）    |
| R2 の読取り手段                       | A: アカウント ID と**読取り専用トークン**。B: `wrangler login`（人のアカウント、ブラウザが要る）                 |
| アプリの設定                          | `~/.config/mirai-sf/prod.conf` 相当（DB 接続・Access の AUD など）。**ホストと一緒に失われる**。値は別保管が要る |
| Cloudflare Access の設定              | ダッシュボード側にあるのでホスト喪失の影響を受けない。新しいホストの Tunnel を同じホスト名へ向け直す             |
| Tunnel の資格情報                     | `~/.cloudflared/<tunnel-id>.json` と `mirai-sf-prod-config.yml`。**ホストと一緒に失われる**。再発行が要る        |

## 5. 手順（別ホスト）

1. Node / PostgreSQL 16 / リポジトリを用意し、`pnpm install`。
2. R2 を読めるようにする（A のトークン、または B の `wrangler login`）。
3. `offsite-recover.mjs --verify-only --out <dir>` で最新を取得・確認（A が使えなければ B で窓を絞る）。
4. `offsite-recover.mjs`（`DATABASE_URL` を新ホストの DB に向けて）で一時DBへの復元訓練が通ることを確かめる。
5. 本番 DB を作り、`<dir>` の dump を `pg_restore` → `pnpm db:verify`。
6. アプリの設定を復元し、API を起動して `/healthz` を確認。
7. Tunnel を作り直す（または資格情報を再発行）し、Access の背後で受付が開くことを確かめる。

## 6. 未解決

- **Tunnel の資格情報と wrangler の OAuth が同じホストにある**。ホストを失うと両方失う。別ホストで `cloudflared tunnel login` / `wrangler login` を人がやり直す必要があり、ブラウザと所有者アカウントが要る。
- 読取り専用 R2 トークンは**未発行**（発行は所有者のダッシュボード操作。本 PR では作らない）。発行するまで A は使えない。トークンの保管場所もホストの外（パスワード管理など）に置く。
- `prod.conf` の値（DB の接続、Access の AUD 等）の別保管が無い。
- 別ホストでの通し訓練は未実施。下の所要時間は見積りで、実測ではない。

## 7. 所要時間の見積り（未実測）

| 段階                                         | 見積り             | 根拠                                                         |
| -------------------------------------------- | ------------------ | ------------------------------------------------------------ |
| ホスト・Node・PG16・リポジトリの用意         | 30〜60 分          | 新規 Ubuntu への導入。`pnpm install` を含む                  |
| R2 の認証（A: トークン / B: wrangler login） | 5〜15 分           | ダッシュボードでの発行またはブラウザでのログイン             |
| 取得と整合（A）                              | 1 分未満           | dump 約 135 KB。B は窓の広さ×3.5 秒（30 秒窓で 33.6 秒実測） |
| 一時DBへの復元訓練                           | 約 32 秒           | `07-slo-and-measurement.md` §3-5 の実測（31.6 秒）           |
| 本番 DB の作成・設定・API 起動               | 30〜60 分          | `prod.conf` の値を別保管から戻せる前提                       |
| Tunnel の作り直しと Access の確認            | 30〜60 分          | `cloudflared tunnel login`・DNS の向け直し・OTP の確認       |
| **合計**                                     | **約 2〜3.5 時間** | RTO 4 時間（案）に収まる見込み。ただし未実測                 |
