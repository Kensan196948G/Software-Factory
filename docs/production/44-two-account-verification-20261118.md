# 2アカウント認証運用の業務フロー実測（2026-11-18 / 隔離環境）

作成: 2026-11-18 11:23 JST。対象: main `bb7c2426`（HEAD。開始時点の作業ツリーはクリーン）。状態: **隔離環境で実測完了（PASS 17 / FAIL 0）。本番環境では未実施。**

本書は、本番の認証運用を「承認者（管理者）1名 + 利用者（requester）1名」の2アカウントに絞った構成で、受付から承認・注文書までの業務フローが API で実際に通るかを、使い捨て DB・別ポートの隔離環境で HTTP 実測した記録である。実測した事実だけを書き、実測していないことは「未実施」「未確認」と明記する。

## 1. 目的と結論

- **目的**: 2アカウント構成（承認者=`approver` のみ + `is_admin=true`、利用者=`requester` のみ + `is_admin=false`、他は無効）で、依頼作成 → 受付 → 内容確認中 → 承認待ち → 承認 → 注文書取得 → 監査記録の業務フローが通ることを確認する。あわせて、依頼者による自己承認の拒否、`is_admin=true` の承認者でも自己承認が拒否されること、`desk` 専任を置かなくても承認者だけで受付〜承認待ちへ進められることを実測する。
- **結論（実測）**: 上記はすべて期待どおり成立した。**PASS 17 / FAIL 0**。
  - 承認者ロールのみ（`desk` を持たない）で `受付 → 内容確認中 → 承認待ち` の遷移が 200 で通った（`roleCanTransition` は承認者にも受付担当相当の遷移を許す実装。`src/shared/domain.ts`）。
  - `is_admin=true` の承認者でも、自分が起票した依頼の承認は **403 `ERR-105`** で拒否され、状態・版は変わらなかった。
  - 依頼者の自己承認は、役割判定の段階で **409 `ERR-201`** となり、状態・版は変わらなかった。
- **限界**: 本番の認証経路は Cloudflare Access（OTP）+ JWT 検証（`AUTH_MODE=access`）であり、今回実測したのはアプリのパスワードログイン経路（`AUTH_MODE=password`）である。認証経路が異なるため、本書の PASS は「本番の Access ログインが通る」ことの証明ではない（§7・§8）。

## 2. 前提: 依頼文の伏字の補完

- 依頼文のメールアドレスは `<EMAIL_1>` / `<EMAIL_2>` に伏字されて届いた。推測で決めず、Lead の指示に従い、本番 DB への**読み取り専用 SELECT**（`mirai_sf_prod`、`-h /var/run/postgresql`）で有効な利用者を確定した。実行は 2026-11-18 11:19 JST、**SELECT のみで書き込みはしていない**。
- 読み取り結果: 有効な利用者は **2名だけ**で、`is_admin=t` かつ `role=approver` の gmail 側と、`is_admin=f` かつ `role=requester` の yahoo.co.jp 側であった。役割で判別し、前者を **EMAIL_1（承認者）**、後者を **EMAIL_2（利用者）** として使用した。
- 本番設定の許可リストも Lead が確認済み（2件）。本番は 11:18 JST に main `bb7c2426` へ配備済みとの連絡を受けているが、**本書では本番の稼働確認はしていない**（本番 DB の参照は上記 SELECT のみ、本番 API への書き込みはしていない）。
- 文書ではメールを `ken***@gmail.com` / `ken***@yahoo.co.jp` とマスクする。検証用パスワードは 0600 のローカルファイルだけに置き、本書・リポジトリ・ログには記載していない。
- 本番の2アカウント化そのものの実施記録は Lead の `45-auth-two-account-20261118.md` にある。本書は、その構成で業務フローが通るかを隔離環境で実測した記録である。

## 3. 環境

| 項目                   | 実測値                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 実行日時（JST）        | 2026-11-18 11:19–11:23（DB 作成・migrate/seed 11:20、API 起動 11:20:49、HTTP 実測 11:21–11:22、後片付け 11:23）                                              |
| リポジトリ             | `/mnt/storage/Software-Factory/Software-Factory`、main `bb7c2426`、作業ツリー clean                                                                          |
| 実行環境               | Node v22.22.3、pnpm 12.21.0、PostgreSQL 18（ローカル、peer 認証）                                                                                            |
| 隔離 DB                | `mirai_sf_2acct_20261118_test`（実行後に drop 済み。既存 DB へは書き込みなし）                                                                               |
| API                    | `127.0.0.1:18995`（`HOST=127.0.0.1`、`PORT=18995`）。PID 3588307（tsx CLI）/ 3588327（node サーバ）。実行後に停止し、ポート解放を確認                        |
| `NODE_ENV` / `APP_ENV` | `test` / `test`                                                                                                                                              |
| 認証モード             | `AUTH_MODE=password`（アプリのログイン API で実測）                                                                                                          |
| 自己承認               | `ALLOW_SELF_APPROVAL=0`（本番既定と同じ拒否）                                                                                                                |
| メール                 | `MAIL_MODE=file`、送信 BOX は `/tmp/sf-2acct/mail`                                                                                                           |
| DB 接続                | `DATABASE_URL=postgresql:///mirai_sf_2acct_20261118_test?host=/var/run/postgresql`                                                                           |
| migration / seed       | `pnpm -s exec tsx scripts/db.ts migrate` → 0001〜0017 適用、テーブル 30 件。`seed` → 部署 19（選択可 16）/ 道具 118 / 見本依頼 9 / 管理者 1。いずれも exit 0 |
| 付帯検証               | `scripts/db.ts verify` が **9/9 OK**（依頼データ 11 件 = 見本 9 + 検証 2、監査ハッシュ連鎖 21 件 OK）                                                        |
| 5xx                    | 実測した全リクエストで期待外の 5xx は観測していない。API ログに `level>=40` の記録なし                                                                       |

- migrate / seed は `scripts/local-run.mjs` を通さず、明示した `DATABASE_URL` で直接実行した（`local-run` は `~/.config/mirai-sf/local.json` を注入し、既存の開発 DB 設定で上書きされ得るため）。
- ポートは 18995–18997 の範囲だけを確認し、18995 を使用した。他プロセスの kill・再起動はしていない。

## 4. アカウント構成（目標との一致）

ユーザー作成の正規経路はコードで確認した。`scripts/ops/add-user.ts` は本番専用のガード（`~/.config/mirai-sf/prod.conf`、`mirai_sf_prod` 固定）があるため隔離 DB では使えない。同じ内部経路である `src/api/auth.ts` の `createUser`（`LocalAdminActor` = local-cli）と `setUserRoles` を使った。無効化・有効化は管理 API（内部で `setUserActive` と監査記録）で行った（スクリプトは `/tmp/sf-2acct/setup-users.mts`、`/tmp/sf-2acct/verify.mts`）。

| 役割             | メール（マスク）     | `is_admin` | `is_active` | `roles`              | 作り方                                                                                     |
| ---------------- | -------------------- | ---------- | ----------- | -------------------- | ------------------------------------------------------------------------------------------ |
| 承認者（管理者） | `ken***@gmail.com`   | true       | true        | `["approver"]` のみ  | `seed` で管理者として作成 → `setUserRoles` で approver のみに絞る（requester/desk を除去） |
| 利用者           | `ken***@yahoo.co.jp` | false      | true        | `["requester"]` のみ | `createUser`（dept `eigyo`、`isAdmin=false`、`roles=["requester"]`）                       |
| その他           | —                    | —          | —           | —                    | **0名**（seed の管理者は上記の承認者を兼ねる。seed の見本依頼は `app_user` ではない）      |

- DB 直読の最終確認: `app_user` は合計 2 行、**有効 2 / 無効 0**。有効な利用者は上記 2 名だけで、本番（11:19 の読み取り）と同じ役割構成である。
- 承認者を `approver` のみにしたため、`desk` ロールを持つ利用者は 0 名。それでも受付〜承認待ちまで進められることを §5 の #6・#7 で実測した。

## 5. チェック表（PASS 17 / FAIL 0）

判定は、応答の HTTP ステータス・エラーコード・状態・版・DB の実値がすべて期待に一致した場合だけ PASS とした。各項目の生の応答は `/tmp/sf-2acct/http/<id>.json`、集約は `/tmp/sf-2acct/evidence.json` に残している。

| #   | 内容                                                            | 期待                                                                                    | 実測                                                                                                                                              | 判定 |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | 隔離 API の稼働確認（`GET /healthz`）                           | 200 / `environment=test` / `auth.mode=password` / `usersActive=2` / `db.ok=true`        | HTTP 200、`environment=test`、`mode=password`、`usersActive=2`、`db.ok=true`                                                                      | PASS |
| 2   | 利用者ログイン → `GET /api/auth/me`                             | 200 / `actingRole=requester` / `roles=["requester"]` / `isAdmin=false`                  | ログイン 200、me 200、`requester` / `["requester"]` / `false`                                                                                     | PASS |
| 3   | 利用者が依頼を新規作成（`POST /api/requests`）                  | 201 / `received` / 件名に「2ACCT検証 2026-11-18」/ 起票者=利用者 / 承認者=承認者        | 201、`REQ-2026-0010`、`received`、version 1、件名一致、`applicantUserId`=利用者、`approverUserId`=承認者                                          | PASS |
| 4   | 利用者が自分の依頼を承認しようとする                            | 409 `ERR-201` / `received` のまま / version 不変 / 決定色なし                           | 409 `ERR-201`、`received`、version 1 のまま、`signalDecided=null`                                                                                 | PASS |
| 5   | 承認者ログイン → `GET /api/auth/me`                             | 200 / `actingRole=approver` / `roles=["approver"]` / `isAdmin=true`                     | ログイン 200、me 200、`approver` / `["approver"]` / `true`                                                                                        | PASS |
| 6   | **承認者ロールのみ**で 受付 → 内容確認中（desk 無し）           | 200 / `review` / version +1                                                             | 200、`review`、version 1→2                                                                                                                        | PASS |
| 7   | **承認者ロールのみ**で 内容確認中 → 承認待ち（desk 無し）       | 200 / `wait` / version +1 / 承認依頼メールが送信簿に積まれる                            | 200、`wait`、version 2→3、送信簿に `sent` の1通                                                                                                   | PASS |
| 8   | 候補よりゆるい信号で理由なしの承認                              | 400 `ERR-102` / `wait` のまま / version 不変                                            | 候補=黄。400 `ERR-102`、`wait`、version 3 のまま、決定色なし                                                                                      | PASS |
| 9   | 信号を決めて承認（候補よりゆるい色 + 理由）                     | 200 / `approved` / `signal=g` / `order_version=1`                                       | 200、`approved`、決定色 青（`g`）、`order_version=1`、version 3→4                                                                                 | PASS |
| 10  | 注文書 YAML（`GET /api/requests/:id/order`）                    | 200 / 受付番号・合格条件・`order_version` が依頼と一致                                  | 200、`id: "REQ-2026-0010"`、合格条件 2件一致、`order_version: 1`、`signal.decided: "青"`、`version=1`                                             | PASS |
| 11  | 監査ログ（`GET /api/audit-logs`）                               | `request.create` / `request.transition` / 拒否 / ハッシュ連鎖 ok                        | `request.create` 1件、`request.transition` 3件（success）、`request.transition_denied`（requester）1件、`chain.ok=true`                           | PASS |
| 12  | 承認者は依頼者ではない / `actingRole` を requester へ切替       | 承認者ID≠起票者ID / 切替は 403 `ERR-101`                                                | ID 不一致を確認、切替 403 `ERR-101`（approver しか持たないため）                                                                                  | PASS |
| 13  | **`is_admin=true` の承認者による自己承認**                      | 403 `ERR-105` / `wait` のまま / version 不変                                            | 承認者自身が起票した `REQ-2026-0011` を `wait` まで進め、承認を試行 → 403 `ERR-105`、`wait`、version 3 のまま、決定色なし                         | PASS |
| 14  | 利用者の無効化（`PATCH /api/admin/users/:id` `isActive=false`） | 200 / `isActive=false` / 監査に `user.deactivate`                                       | 200、`isActive=false`、監査に success 1件                                                                                                         | PASS |
| 15  | 無効化された利用者のセッション失効                              | 既存セッション 401 / 再ログインも 401                                                   | `GET /api/auth/me` 401、再ログイン 401                                                                                                            | PASS |
| 16  | 利用者の有効化と再ログイン                                      | 200 / `isActive=true` / 再ログイン 200 / `requester`                                    | 200、`isActive=true`、再ログイン 200、me 200（`requester`）                                                                                       | PASS |
| 17  | 最終構成（DB 直読）                                             | 有効2名のみ / gmail=approver+admin / yahoo=requester+非admin / 依頼は `approved` のまま | 有効2名（`ken***@yahoo.co.jp:requester`、`ken***@gmail.com:approver/admin`）、依頼 `REQ-2026-0010` は `approved` / `order_version=1` / `signal=g` | PASS |

- **PASS 17 / FAIL 0**。付帯して、`scripts/db.ts verify` が 9/9 OK、migrate（テーブル 30 件）と seed（部署 19・道具 118・見本 9）も exit 0。
- 判定に使った状態・版は、各操作後に `GET /api/requests/:id` で再取得した値と DB 直読の両方で確認した。

## 6. 主要な実測値（証跡からの抜粋）

- 受付番号: `REQ-2026-0010`（利用者が作成した本検証の依頼）。自己承認境界用: `REQ-2026-0011`（承認者自身が起票）。
- 状態遷移: `received`（v1）→ `review`（v2）→ `wait`（v3）→ `approved`（v4）。承認時の決定色は `g`（青）、候補は `y`（黄）、`order_version=1`。
- 注文書 YAML の該当行（全文は `/tmp/sf-2acct/order.yaml`）:

```text
order_version: 1
id: "REQ-2026-0010"
title: "2ACCT検証 2026-11-18 受付から承認までの業務フロー"
status: "承認済み"
signal:
  suggested: "黄"
  decided: "青"
acceptance_criteria:
 - "検索結果が2秒以内に表示されること"
 - "同じ見積番号を二重に登録できないこと"
```

- 監査（DB 直読、`REQ-2026-0010`）: `request.create`（requester）→ `request.transition_denied`（requester）→ `request.transition`（approver）×3。`REQ-2026-0011` には `approval.self_denied`（approver）が残った。監査のハッシュ連鎖は `db.ts verify` で 21 件 OK。
- 承認レコード: `approver=Kensan`、`decision=approved`、`decided_signal=g`、`suggested_signal=y`、理由「候補は黄だが、社外に見せるのは見積の下書きのみで、金額の確定は人が行うため青とした」、`order_version=1`。
- メール: `REQ-2026-0010` の承認待ち遷移で `MAIL_MODE=file` の送信 BOX に 1 通（`status=sent`）。自己承認境界用の `REQ-2026-0011` でも別に 1 通（合計 2 通）。

## 7. 本番との差（重要）

**本番の認証は Cloudflare Access（OTP）+ `Cf-Access-Jwt-Assertion` の JWT 検証であり、今回の実測はアプリのパスワードログインであり、認証経路が違う。** 今回の PASS は「2アカウント構成でアプリの認可・業務フローが通る」ことの証明であって、「本番の Access ログインが通る」ことの証明ではない。

| 項目                   | 本番（`00-adr.md`・`02-runbook.md` の記載）                                                                                                           | 今回の実測                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 認証経路               | Cloudflare Access（OTP）→ Worker → API。`AUTH_MODE=access`、`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` による JWT 検証。ヘッダ信頼は本番で禁止（起動エラー） | `AUTH_MODE=password`。`POST /api/auth/login` のメール+パスワード。Access ヘッダ・JWT は未使用 |
| 到達経路               | `https://sf-prod.mirai-dx-platform.com`（Cloudflare Tunnel）、API は `127.0.0.1:8783`                                                                 | `http://127.0.0.1:18995` へ直接（TLS なし、Access なし）                                      |
| `NODE_ENV` / `APP_ENV` | `production` / `production`                                                                                                                           | `test` / `test`                                                                               |
| Cookie                 | `Secure` 有効、SameSite=Lax                                                                                                                           | `Secure` 無効（test 既定）                                                                    |
| Origin 共有秘密        | `REQUIRE_ORIGIN_SECRET=1`                                                                                                                             | `0`（test 既定）                                                                              |
| メール                 | `MAIL_MODE=off`（本番既定）                                                                                                                           | `MAIL_MODE=file`（ローカル送信 BOX）                                                          |
| ログイン試行制限       | 有効（15分10回）                                                                                                                                      | `NODE_ENV=test` のため無効（`checkLoginRate`）                                                |
| 自己承認               | `ALLOW_SELF_APPROVAL=0`（本番既定）                                                                                                                   | 明示的に `0`。同じ拒否を実測                                                                  |
| DB                     | `mirai_sf_prod`                                                                                                                                       | `mirai_sf_2acct_20261118_test`（同一 migration 0017、実行後 drop）                            |
| コード                 | main `bb7c2426`（11:18 に配備済みとの Lead 連絡。本書では本番稼働を再確認していない）                                                                 | 同じ main `bb7c2426` のソースを `tsx` で起動                                                  |

- 認可（`roleCanTransition`、自己承認拒否、監査、注文書）はアプリのコードで決まるため、本番でも同じ規則が使われる。ただし **Access/JWT の認証部分は今回の実測に含まれない**。
- 補足（コード読解、本番構成では未実測）: `AUTH_MODE=access` でも `POST /api/auth/login` 自体は無条件に定義されている。JWT 検証が有効な本番構成では、JWT のないリクエストは `onRequest` で `ctx=null` になり API は 401 になる（`src/api/app.ts`）が、この組合せは今回実測していない。外部からは Cloudflare Access が手前で遮る前提である。

## 8. 未実施事項

- **Cloudflare Access の OTP ログインと JWT 検証経路**での2アカウント実測（本番の実際の認証経路。今回のパスワード認証とは別）。
- 本番 DB・本番 API への書き込み、本番での業務実施（本番 DB は読み取り SELECT のみ）。
- ブラウザ UI（`station.js`）での操作。今回は HTTP API のみで、画面の表示・無効化・トースト等は未確認。
- 実メールの到達（`MAIL_MODE=file`。SMTP / sendmail は未使用）。
- ログイン試行制限（`NODE_ENV=test` で無効）。Cookie の `Secure`、TLS、Cloudflare 層の挙動。
- 差戻し → 再提出、取消・見送り、赤信号の承認、承認前チェックの△、監査 CSV、バックアップ/復元、worker、開発ライン。
- 承認者1名が不在・無効化された場合の代替承認（エスカレーション）は、仕様として確認していない。

## 9. 残リスク

- **認証経路の差が最大の残リスク**。今回 PASS したのはアプリのパスワード認証。本番の Access（OTP）→ JWT 検証で同じ2アカウントがログインできるかは未実測。Cloudflare Access のポリシー・許可リスト・JWT 設定のいずれかがずれると、アプリの認可が正しくてもログインできない。
- **`desk` 専任を置かない運用**のため、受付・内容確認・承認をすべて承認者が行う。今回、承認者だけで `受付 → 内容確認中 → 承認待ち → 承認` が通ることを実測した（意図どおり）が、受付と承認の職務分離はなく、誤操作を止めるのは画面と運用に依存する。
- 承認者は `is_admin=true` の単一管理者でもあるため、利用者管理・監査閲覧・取込もできる。アカウント漏えい時の影響が大きい。
- 承認者が1名のため、不在・無効化時に承認が止まる。仕様上「最後の管理者は無効化できない」が、代替承認者を用意する仕組みは未確認。
- パスワードログイン経路がコード上は本番にも存在する（Access が手前で遮る前提）。Access/JWT の設定変更や到達経路の変化に対する多層防御は、今回の実測範囲では確認できていない。
- 監査ログの完全性は DB 管理者権限に依存する（既知の限界）。今回のハッシュ連鎖 OK は、DB 所有者による改ざんを防ぐものではない。
- 隔離環境は `NODE_ENV=test` のため、レート制限・Cookie Secure・Origin 共有秘密など本番と異なる設定で PASS している。これらの設定差が業務フローに与える影響は未実測。
- 検証用の使い捨て DB は drop 済みのため、証跡は `/tmp/sf-2acct/` に依存する。再起動・清掃で失われる可能性がある。

## 10. 証跡の置き場所（リポジトリ外）

`/tmp/sf-2acct/` に保存した（リポジトリには入れていない）。主なもの:

| ファイル                                              | 内容                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| `prod-users-readonly.txt`                             | 本番 DB の読み取り専用 SELECT の結果（有効2名の確認）                |
| `migrate.log` / `seed.log`                            | 隔離 DB の migration（0001〜0017、テーブル 30）と seed の記録        |
| `users-setup.json`                                    | 2アカウント構成の作成結果（メールはマスク、ID・役割・有効状態）      |
| `healthz.json` / `healthz.headers`                    | 隔離 API の `/healthz` 応答                                          |
| `evidence.json` / `http/*.json`                       | 17チェックの期待・実測・合否と各応答                                 |
| `verify.log`                                          | 17チェックの実行ログ（PASS/FAIL 一覧）                               |
| `order.yaml`                                          | 取得した注文書 YAML の全文                                           |
| `db-snapshot.txt`                                     | 利用者・依頼・承認・監査・履歴・セッションの DB 直読結果             |
| `db-verify.log`                                       | `scripts/db.ts verify` の 9/9 OK                                     |
| `api.log` / `api-env.txt` / `api.pid` / `process.txt` | API の起動ログ、環境（秘密を除く）、PID、待受                        |
| `mail/*.eml`                                          | `MAIL_MODE=file` の送信 BOX（承認依頼メール）                        |
| `cleanup.log`                                         | API 停止（SIGTERM）・ポート解放・DB drop の確認                      |
| `setup-users.mts` / `verify.mts`                      | 実行したセットアップ・検証スクリプト（パスワードは埋め込んでいない） |

## 11. 再現手順（要旨）

1. 隔離 DB を作る（既存 DB は使わない）: `createdb -h /var/run/postgresql mirai_sf_2acct_20261118_test`。
2. `DATABASE_URL='postgresql:///mirai_sf_2acct_20261118_test?host=/var/run/postgresql'`、`NODE_ENV=test`、`APP_ENV=test`、`SEED_ADMIN_EMAIL='ken***@gmail.com'`、`SEED_ADMIN_PASSWORD=***` を設定し、`pnpm -s exec tsx scripts/db.ts migrate` → `seed`（`local-run` は使わない）。
3. `/tmp/sf-2acct/setup-users.mts` を実行し、承認者を `approver` のみ、利用者を `requester` のみで作成（`setUserRoles` / `createUser`）。
4. `127.0.0.1:18995`、`NODE_ENV=test`、`APP_ENV=test`、`AUTH_MODE=password`、`ALLOW_SELF_APPROVAL=0`、`MAIL_MODE=file`、上記 `DATABASE_URL`、`MAIL_OUTBOX_DIR=/tmp/sf-2acct/mail` で `./node_modules/.bin/tsx src/api/server.ts` を起動（PID とログを記録）。
5. `/tmp/sf-2acct/verify.mts` を実行（Cookie と CSRF を保持し、`/api/auth/login` から `/api/audit-logs` まで実測）。
6. API を SIGTERM で停止し、ポート解放を確認してから `dropdb`。証跡は `/tmp/sf-2acct/` に残す。

パスワードは検証用に生成した値だけを使い、コマンドライン・文書・リポジトリ・ログには出していない（0600 のローカルファイルのみ）。

## 12. 後片付けの確認

- API プロセス: PID 3588307（および子 3588327）へ SIGTERM を送り、`127.0.0.1:18995` の待受が消えたことを `ss` で確認した。他のプロセス（別プロジェクトの `src/api/server.ts` を含む）には触れていない。
- 隔離 DB: `dropdb` 実行後、`pg_database` に `mirai_sf_2acct_20261118_test` が存在しないこと（count=0）を確認した。
- 既存 DB（`mirai_sf_prod` / `mirai_sf` / `mirai_sf_dev` / `mirai_sf_test`）と稼働中サービス（`mirai-sf-api`、`mirai-sf-prod-api`、worker 等）への書き込み・再起動・停止はしていない。本番 DB は §2 の読み取り SELECT のみ。
- 本作業で変更したリポジトリファイルは本書 1 ファイルだけである（git commit / push / PR / merge はしていない）。本作業中に他の担当者による別ファイルの変更が並行して発生しているが、本作業では触れていない。
