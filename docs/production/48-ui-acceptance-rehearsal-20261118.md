# 業務受入の画面予行（2026-11-18 / 隔離環境）

作成: 2026-11-18 12:38 JST。対象: main `18a297af`（`bb7c2426` からの差分は `docs/production/` の 7 ファイルのみで、`src/` の変更は 0。画面のソースは本番 `bb7c2426` と同一）。状態: **隔離環境で画面予行を実施（PASS 11 / FAIL 1、画面の詰まり 7 件）。本番環境では未実施。**

本書は、人間がこれから行う本番の「業務受入」（`42-business-acceptance-plan-20261113.md` §2、承認者が受付担当を兼ねる読み替えあり）を、**同じ画面操作の順序**で隔離環境の実ブラウザ（Chromium）から予行し、画面で詰まる箇所を実測した記録である。実測した事実だけを書き、実測していないことは「未実施」と明記する。本文書以外のリポジトリファイルは変更していない（Git 操作もしていない）。

## 1. 目的と結論

- **目的**: 2 アカウント（承認者 = `approver` のみ・管理者 / 利用者 = `requester` のみ）で、`42` §2 の順序どおりに「ログイン → 新しい依頼（7 ステップ）→ 内容確認中 → 承認待ち → 承認 → 注文書 → 自己承認の拒否 → ログアウト」を**画面から**実行し、画面で詰まる箇所を実測する。あわせて、**承認者ロールのみ（`desk` 無し）**で受付〜承認が画面から通ることを確認する。
- **結論（実測）**:
  - **承認者ロールのみ（`desk` を持たない）で、受付 → 内容確認中 → 承認待ち → 承認 が画面から通った**（PASS）。状態変更は「詳細パネルの主ボタン」と「旗アイコン（`title="状態を変更"`）」の両方で確認した。
  - 依頼の登録〜受付番号の発番、承認時の信号の色の決定、候補よりゆるい色の理由必須（送信前に止まる）、監査ログへの記録、ログアウト後の再ログイン要求まで、画面から成立した。
  - **FAIL は 1 件**: `42` §2 手順 5 が求める **`order_version` が画面の「注文書」タブに出ない**（サーバの注文書 API にはある）。業務受入では、この 1 点だけ画面から確認できない（§6 F-1）。
  - **画面の詰まりは 7 件**（High 1 / Medium 3 / Low 3）。最も重いのは、**役割セレクタで保持していない「承認者」を選ぶと、画面が承認者として描画され、承認実行時に「承認完了」の成功演出を出した後にサーバ拒否の赤トーストが出る**（§6 F-2・F-3）。状態・版・監査は正しく拒否されており、データは壊れない。しかし人が見ると成功と誤認しうる。
  - 5xx・JavaScript 例外（`pageerror`）は **0 件**。観測した 4xx は 13 件で、すべて意図した試行（役割切替の拒否・自己承認の拒否・ログアウト後の 401）と、下記 F-5（非管理者の監査ログ要求 403）に説明できる。
- **限界**: 本番の認証は Cloudflare Access（OTP）+ JWT 検証であり、今回の実測はアプリのパスワードログイン（`AUTH_MODE=password`）である。**本番の Access ログインが通ることの証明ではない**（§7）。

## 2. 環境

| 項目                   | 実測値                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実行日時（JST）        | 2026-11-18 12:18–12:36（DB 作成 12:18、migrate/seed/ユーザー作成 12:19、API 起動 12:19、試行 12:22–12:30（3 回）、**記録用の実行 12:32:16–12:33:00（44 秒）**、DB 確認・後片付け 12:33–12:36）                             |
| リポジトリ             | `/mnt/storage/Software-Factory/Software-Factory`、main `18a297af`、開始時 `git status` クリーン                                                                                                                            |
| 実行環境               | Node v22.22.3、pnpm 12.21.0、PostgreSQL 18（ローカル、peer 認証）                                                                                                                                                          |
| ブラウザ               | Playwright 1.64.1 / Chromium **156.0.8078.4**（headless、viewport 1440×900、`locale=ja-JP`）                                                                                                                               |
| 隔離 DB                | `mirai_sf_2acct_ui_20261118_test`（実行後に drop 済み）。`DATABASE_URL=postgresql:///mirai_sf_2acct_ui_20261118_test?host=/var/run/postgresql` を明示                                                                      |
| migration / seed       | `pnpm -s exec tsx scripts/db.ts migrate`（0001〜0017、テーブル 30 件、exit 0）→ `seed`（部署 19 / 道具 118 / 見本依頼 9 / 管理者 1、exit 0）。`scripts/local-run.mjs` は使っていない                                       |
| API                    | `127.0.0.1:18996`（`HOST=127.0.0.1`、`PORT=18996`）。`./node_modules/.bin/tsx src/api/server.ts`。実行後に SIGTERM で停止し、ポート解放を確認                                                                              |
| `NODE_ENV` / `APP_ENV` | `test` / `test`                                                                                                                                                                                                            |
| 認証モード             | `AUTH_MODE=password`（画面の `/login` フォーム）                                                                                                                                                                           |
| 自己承認               | `ALLOW_SELF_APPROVAL=0`（本番既定と同じ拒否）                                                                                                                                                                              |
| メール                 | `MAIL_MODE=file`、送信 BOX `/tmp/sf-ui-rehearsal/mail`、`MAIL_APPROVAL_TO=<承認者>`                                                                                                                                        |
| ログ                   | `DEBUG_TEST=1`（テスト時のリクエストログ抑制を外す指定）。ただし `NODE_ENV=test` では `disableRequestLogging` が真のため、API ログにリクエスト行は出ない（起動行のみ）。5xx の判定はブラウザ側の応答捕捉と DB 監査で行った |
| 検証                   | `scripts/db.ts verify` が **9/9 OK**（依頼データ 10 件 = 見本 9 + 本予行 1、監査ハッシュ連鎖 15 件 OK）                                                                                                                    |
| 5xx                    | ブラウザが受けた全応答で **5xx は 0 件**。`pageerror` も 0 件                                                                                                                                                              |

- ポートは 18995–18998 の範囲だけを確認し、18996 を使用した。他プロセスは kill していない（別プロジェクトの `src/api/server.ts` には触れていない）。
- 本番（`mirai_sf_prod` / `127.0.0.1:8783`）、Staging（`mirai_sf` / 8782）、開発 DB へは**接続もしていない**（本番 API の healthz も今回は未実施）。書き込みは当然していない。
- seed の見本依頼 9 件が一覧・ボードに混在するため、「確認・承認」画面には見本も並ぶ。予行では対象を**受付番号**で特定した。

## 3. アカウント構成（目標との一致）

作成方法は `44-two-account-verification-20261118.md` §4 と同じ正規経路を使った。`scripts/ops/add-user.ts` は本番専用ガードがあるため使っていない。スクリプトは `/tmp/sf-ui-rehearsal/setup-users.mts`（パスワードは env からのみ受け取り、出力しない）。

| 役割             | メール（マスク）     | `is_admin` | `is_active` | `roles`              | 作り方                                                                                       |
| ---------------- | -------------------- | ---------- | ----------- | -------------------- | -------------------------------------------------------------------------------------------- |
| 承認者（管理者） | `ken***@gmail.com`   | true       | true        | `["approver"]` のみ  | `seed` で管理者として作成 → `setUserRoles` で approver のみに絞る（requester/desk を除去）   |
| 利用者           | `ken***@yahoo.co.jp` | false      | true        | `["requester"]` のみ | `createUser`（dept `eigyo`、`isAdmin=false`、`roles=["requester"]`、`LocalAdminActor` 経由） |
| その他           | —                    | —          | —           | —                    | **0 名**（seed の管理者は承認者を兼ねる）                                                    |

- 実行後の DB 直読: `app_user` は 2 行、**有効 2 / 無効 0**。`role` はそれぞれ `approver` / `requester` の 1 つだけ。`is_admin` は承認者のみ true。
- したがって `desk` ロールを持つ利用者は 0 名。この状態で受付〜承認が画面から通ることを §5 の d・e で実測した。

## 4. 画面の配信方法（同一ポートか、vite 別ポートか）

**同一ポート（`127.0.0.1:18996`）の静的配信を選んだ。** ただし配信物は再ビルドした。

1. まず API 起動後に確認した: `GET /` は **302 → `/login`**（未ログインのため。`AUTH_MODE=password` の分岐どおり）、`GET /login` は **200**（2,878 B のログインフォーム）、`GET /station.js` は **200**。**画面（`station.js`）は API と同じポートで配信される**。
2. ただし配信されていた `dist/web` は **2026-11-11 21:07 のビルド**で、`src/web/public/station.js`（2026-11-18 11:11）と**バイト一致しなかった**（配信 235,188 B / md5 `3a9fcc7c…`、ソース 244,801 B / md5 `7dd73bc9…`）。本番 `bb7c2426` は現在のソースをビルドして配信しているはずであり、古いビルドで予行すると 2026-11-13 の画面修正（`17c91f43` などの保存失敗・承認理由の修正）が入らない。**予行の意味が変わるため、HEAD のソースから `pnpm build:web`（vite 6.4.5）で再ビルドして配信した。**
3. 再ビルド後、配信された `station.js` は **244,801 B / md5 `7dd73bc975d4bff689e219b333e903ba` で `src/web/public/station.js` とバイト一致**（`dist/web/index.html` は `<!--MSF_BOOT-->` を保持したまま再生成）。旧 `dist/web` は `/tmp/sf-ui-rehearsal/logs/dist-web-before.tar.xz` に退避した。
4. `vite` を別ポートで起動する案は採らなかった。理由は (a) `vite.config.ts` の `server.proxy` が `127.0.0.1:8781` 固定で、今回の API 18996 を指すには設定の追加が必要、(b) 本番は「API と同一オリジンで `dist/web` を配信する」経路であり、**同じ配信経路**で測るほうが本番に近い、の 2 点。
5. リポジトリへの影響: `dist/` は `.gitignore` 済みのビルド生成物で、**追跡ファイルの変更はない**（予行後の `git status --short` は空）。画面のソースは変更していない。

## 5. 手順ごとの実測（`42` §2 の順序）

実行は 1 本の Playwright スクリプト（§11）で、**利用者と承認者は別のブラウザコンテキスト**（Cookie も別）で操作した。状態の確認は画面の表示に加えて、画面内からの**読み取り専用** `GET /api/requests/:id` で突き合わせた（状態を進める操作はすべて画面から）。

| #    | 手順（`42` §2）          | 画面で押したもの                                                                                                                                                                 | 画面に出たもの / 実測                                                                                                                                                                                                                   | 判定               |
| ---- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| a    | ログイン（利用者）       | `/login` のメール・パスワード → 「ログイン」                                                                                                                                     | ダッシュボード、`#stat`「サーバ保存」、`me.actingRole=requester`、`roles=["requester"]`、`isAdmin=false`                                                                                                                                | PASS               |
| a-2  | 役割の抑止（追加観察）   | 右上「操作する人」で「承認者」を選択                                                                                                                                             | トースト「この操作をする権限がありません」、`POST /api/auth/role` は 403（**同一要求が 2 回**送られる: F-7）、サーバの `actingRole` は requester のまま。画面の役割表示だけが承認者に変わる（F-2）                                      | PASS               |
| b    | 新しい依頼（7 ステップ） | 「つぎへ」×6、使う人のチップ、件名・困りごと・目的、作るもの、合格条件 2 件（「条件を追加」で 2 行目）、「この道具は何をしますか」=黄、承認者=`Kensan`、「この内容で受け付ける」 | **受付スタンプ `REQ-2026-0010`** とトースト「受け付けました（REQ-2026-0010）」、ボードに表示。サーバ `received` / version 1 / 起票者=利用者 / 承認者=承認者                                                                             | PASS               |
| c    | ログイン（承認者）       | 別コンテキストの `/login` で「ログイン」                                                                                                                                         | `me.actingRole=approver`、`roles=["approver"]`、`isAdmin=true`                                                                                                                                                                          | PASS               |
| d    | 状態変更                 | 「確認・承認」→ 対象を選択 → **主ボタン「「内容確認中」へ進める」→「変更する」**、続いて **旗アイコン（`title="状態を変更"`）→「変更する」**                                     | トースト「…を「内容確認中」にしました」「…「承認待ち」にしました」。サーバ `review` v2 → `wait` v3。**承認依頼メール 1 通**が送信簿に積まれた（`mail.enqueue` / `mail.sent`、`.eml` 1 件）                                              | PASS               |
| g-1  | 自己承認（画面の抑止）   | 利用者で「確認・承認」→ 自分の依頼を選択（**読み直し後**）。主ボタンは押さず状態確認 → 旗アイコンでダイアログ                                                                    | 主ボタン「承認する（色を決める）」は **disabled**。ダイアログは **12 状態すべて disabled**・「変更する」disabled・「いまの役割では変更できる状態がありません」。送信なし、`wait` のまま                                                 | PASS               |
| g-1b | 自己承認（サーバ拒否）   | 役割セレクタを「承認者」に → 主ボタン「承認する（色を決める）」→ 青を選択・メモ入力 → 「変更する」                                                                               | 画面は「承認完了／承認しました」を表示（**F-3**）→ 赤トースト「「承認済み」にできるのは承認者だけです（最後は人が決めます）」、`POST …/transitions` **409**、状態 `wait`・v3 のまま、監査に `request.transition_denied`                 | PASS               |
| e    | 承認（信号の色）         | 承認者で対象 → 主ボタン「承認する（色を決める）」→ 候補よりゆるい「青」＋**メモ空**で「変更する」（止まるのを確認）→ メモを書いて「変更する」                                    | 空メモ時: トースト「候補よりゆるい色にする理由をメモに書いてください」・ダイアログは開いたまま・状態不変。メモ後: 承認完了ダイアログ（5 工程のチェック）→ サーバ `approved` v4 / 決定色 `g`（青）/ `order_version=1` / 理由が履歴に保存 | PASS               |
| f    | 注文書（YAML）           | 承認完了ダイアログの「注文書を見る」→ ボード右端パネルの「注文書」タブ                                                                                                           | 受付番号・件名・合格条件 2 件は一致。**`order_version` が無い**（`schema_version` も無い）。サーバの `GET /api/requests/REQ-2026-0010/order` には `order_version: 1` / `schema_version: "1.0"` がある                                   | **FAIL**（§6 F-1） |
| g-2  | 承認済みで自己承認       | 利用者で「一覧」→ キーワードで絞り込み → 行を押して詳細 → 旗アイコン                                                                                                             | 主ボタン「「実装中」へ進める」は disabled、ダイアログは全状態 disabled・「変更する」disabled。`approved` / `g` のまま                                                                                                                   | PASS               |
| i    | 監査ログ（手順 7 相当）  | 承認者で「監査ログ」→ キーワードに受付番号 → 絞り込み                                                                                                                            | 画面上に「受付（Kenaritou）」「状態を「内容確認中」に変更」「状態を「承認待ち」に変更」「状態を「承認済み」に変更（Kensan・理由付き）」の 4 行                                                                                          | PASS               |
| h    | ログアウト               | 右上「ログアウト」→ 確認ダイアログの「ログアウトする」（両者）                                                                                                                   | `/login` へ遷移。再アクセスも `/login`、アプリのシェルは出ない、`GET /api/auth/me` は **401**                                                                                                                                           | PASS               |

- **PASS 11 / FAIL 1**（12 項目）。FAIL の理由は製品側の画面欠落（F-1）で、スクリプトの誤りではない。
- 「ボタンが見つからない・押せない」種類の詰まりは **0 件**。主ボタン・旗アイコン・タブ・ダイアログ・ログアウトはすべて画面から特定できた（詰まりは仕様・表示・状態同期に関する §6 の 7 件）。
- スクリプトは試行錯誤で**3 回**実行した（1〜2 回目はスクリプト側のセレクタ誤り・期待値誤りで一部 FAIL。製品側の変更はしていない）。**記録しているのは 3 回目（12:32:16–12:33:00）**で、DB もその前に作り直している（依頼は `REQ-2026-0010` の 1 件のみ）。

### 5-1. 信号の色と注文書の実測値

- 候補（AI の判定）: **黄（チェック付き）**。STEP 6 で「黄」を選んだため（`decides=y` → `judge()` が黄）。
- 承認者の決定: **青（任せる）**。候補より**ゆるい**色のため、理由メモが必須（空では送信前に停止）。入力した理由:
  「候補は黄だが、検索条件の解釈は人が確かめる必要があり、まず試作で確かめられる範囲に限るため青とした」
- サーバ実測: `approved` / version 4 / `signal_decided=g` / `order_version=1` / `approval` 行 `decision=approved, decided_signal=g, suggested_signal=y, order_version=1`。
- 監査（DB 直読）: `request.create`（requester）→ `request.transition`×3（approver）→ `request.transition_denied`（requester）→ `role_switch`×2 → `mail.enqueue` / `mail.sent` → `logout`×2。ハッシュ連鎖は `db.ts verify` で 15 件 OK。

## 6. 詰まり・不具合の一覧（再現手順つき）

重要度は本番の業務受入への影響で付けた。**High** = 人が誤認しうる / 受入の判定ができない、**Medium** = 操作の迷い・確認不能、**Low** = ノイズ・重複。

### F-1（Medium）画面の「注文書」タブに `order_version` が無い — `42` §2 手順 5 が画面で判定できない

- **再現手順**: 承認者が承認を完了 → 承認完了ダイアログの「注文書を見る」→ ボード右端パネルの「注文書」タブ（同じ YAML はタブ内の「ダウンロード」でも得られる）。
- **表示**: 45 行の YAML。`id`（受付番号）・`title`・`status`・`signal.decided`・`acceptance_criteria` は依頼と一致するが、**`order_version` も `schema_version` も含まれない**。
- **サーバ側**: `GET /api/requests/REQ-2026-0010/order` は `schema_version: "1.0"` と `order_version: 1` を返す（`version: 1`）。つまり**画面の YAML はサーバの注文書（正本）とは別の生成物**（クライアント側 `toYAML`）。実際、`data_handling` の文言も画面「特別な情報は扱わない」/ API「特別な情報は扱いません」と異なる。
- **影響**: `42` §2 手順 5 の「注文書が確定版になり、受付番号・合格条件・**order_version** が依頼と一致する」を、**画面からは確認できない**。業務受入では、DevOps 画面の「注文書 版 1」表示か、API/運用の確認で補う必要がある。
- **証跡**: `shots/26-approver-order-yaml.png`、`/tmp/sf-ui-rehearsal/order.yaml`（画面）、`/tmp/sf-ui-rehearsal/order-api.json`（API の先頭 6 行と `order_version` の有無）。

### F-2（Medium）保持していない役割が「操作する人」に並び、画面がその役割として描画される

- **再現手順**: 利用者（`requester` のみ）でログイン → 右上の「操作する人」で「承認者」を選ぶ。
- **表示**: 選択肢は常に 3 役（`requester` / `desk` / `approver`。表示名は Mirai-Info の見本社員）。選ぶとトースト「この操作をする権限がありません」が出て `POST /api/auth/role` は **403**。しかし**画面の役割表示は「技術 一郎／承認者」に切り替わり**、承認ボタンが**有効**になる。サーバのセッション `actingRole` は `requester` のまま（`GET /api/auth/me` で確認）。
- **影響**: 画面が「権限を超えた操作ができる」ように見える。押すと F-3 の誤認を招く。最終防衛はサーバ（403/409）で、認可の穴ではない。
- **証跡**: `shots/03-requester-role-switch-attempt.png`、`shots/20-requester-pseudo-approver-panel.png`、`evidence-ui.json` の `a-2`。

### F-3（High）サーバ拒否より先に「承認完了」の成功演出が出る

- **再現手順**: F-2 の状態（画面だけ承認者）で、対象の詳細パネルの「承認する（色を決める）」→ 信号「青」→ メモ入力 → 「変更する」。
- **表示**: 画面に **「承認完了」「承認しました」「信号の色は 青 に決まりました」と 5 工程のチェック・紙吹雪**が出る。その**後で**画面下部に赤トースト「「承認済み」にできるのは承認者だけです（最後は人が決めます）」。サーバは `POST /api/requests/REQ-2026-0010/transitions` に **409** を返し、状態 `wait`・version 3 のまま、監査に `request.transition_denied`（`result=denied`）が残る。画面のローカル状態はサーバ値（`wait`）へ戻る。
- **影響**: 人が「承認できた」と誤認する。本番で同じ操作をすると、**成功したように見えて実際は承認されていない**。業務受入の記録が誤る恐れがある（重要度 High）。
- **原因（コード読解）**: 画面の `applyStatus()` が `persist()` の結果を待たずに `closeModal()` と `lineModal()`（成功演出）を実行する。失敗は後から `reportSync()` のトーストで通知される。
- **証跡**: `shots/22-requester-pseudo-approver-result.png`（成功演出＋赤トーストが同時に写る）、`shots/21-requester-pseudo-approver-dialog.png`、`evidence-ui.json` の `g-1b`（`writeCalls: [{status:409}]`）。

### F-4（Low）ほかの人の操作は自動反映されない（再読み込みが必要）

- **再現手順**: 利用者のタブを開いたまま、承認者が `内容確認中 → 承認待ち` に進める → 利用者の「確認・承認」で自分の依頼を開く。
- **表示**: 状態は**「受付」のまま**（サーバは `wait` v3）。読み直すと「承認待ち」になる。画面にポーリングは無い（`setInterval` は時計のみ）。
- **影響**: 2 アカウント同時作業では、古い状態を見て操作する可能性。業務受入の手順に「対象を開く前に画面を読み直す」を入れるのが安全。
- **証跡**: `shots/17-requester-stale-tab-before-reload.png`、`evidence-ui.json` の `g-1.staleTabBeforeReload`（`localStatus=received` / サーバ `wait`）。

### F-5（Low）非管理者の画面が起動時に `/api/audit-logs` を要求し、403 がコンソールに出る

- **再現手順**: 利用者（`isAdmin=false`）でログインする、またはページを読み直す。
- **表示**: コンソールに `Failed to load resource: 403` が **2 回**（1 ページ表示あたり）。要求は `GET /api/audit-logs?limit=300` で、サーバは管理者以外を 403 にする。監査ログ画面のサーバ分は空になる。
- **影響**: コンソールのノイズ。監査画面を利用者に見せない設計なら、要求自体をやめる（または画面で非表示にする）ほうがよい。
- **証跡**: `evidence-ui.json` の `badResponses`（`403 /api/audit-logs` ×6 = 3 回のページ表示 ×2）。

### F-6（Medium）画面の利用者名がログインしたアカウントではない（`42` §2 手順 1 の「利用者名」）

- **再現手順**: 利用者／承認者でログイン → ダッシュボードと右上の「操作する人」を見る。
- **表示**: 「こんにちは、**東京**さん」「**東京 一郎（東京支店）**」「**技術 一郎（技術本部）**」など **Mirai-Info の見本社員名**。ログインしたアカウントの表示名（`Kenaritou` / `Kensan`）は画面に出ない（`#role` の `title` には出る）。
- **影響**: `42` §2 手順 1 の期待「画面が表示され、**利用者名**・役割が正しい」は、アカウント名としては満たさない。業務受入では「役割の表示は正しい／名前は Mirai-Info の見本社員」と読み替える必要がある。
- **補足**: 承認依頼メールの本文も「依頼者: 東京 一郎」と表示する（送信簿 `mail/*.eml` で確認）。
- **証跡**: `shots/02-requester-dashboard.png`、`shots/12-approver-dashboard.png`、`mail/*.eml`。

### F-7（Low）役割の切替要求が重複して送られることがある

- **再現手順**: 「操作する人」で「承認者」を選ぶ（保持していない役割）。
- **表示**: `POST /api/auth/role` が **1 回の選択で 2 回**送られ、どちらも 403。利用者へ戻すときは 1 回で 200。最終的なサーバ状態は正しい。
- **影響**: 拒否の通信・監査が増える（`role_switch` は成功した復帰の 2 行のみ）。動作への実害は小さい。
- **証跡**: `evidence-ui.json` の `a-2.roleApiResponses`（配列には後続の `g-1b` の試行も混ざって 6 件 = 403×4・200×2。1 操作あたりでは「承認者へ 2 回・利用者へ 1 回」）。

### 詰まらなかったが記録しておくこと

- 承認者ロールのみ（`desk` 無し）でも、`受付 → 内容確認中 → 承認待ち` の**主ボタンが有効**で、旗アイコンからも同じダイアログが開いた。`42` §2 の「受付担当」は承認者が兼ねられる（`45` §5 の読み替えどおり）。
- 承認時の「候補よりゆるい色 → 理由必須」は**画面が送信前に止めた**（トースト「候補よりゆるい色にする理由をメモに書いてください」、ダイアログは開いたまま、サーバへ送信されない）。`38` / `44` で直した挙動が画面でも維持されている。
- 承認依頼メールは `MAIL_MODE=file` の送信簿に 1 通（`X-Mirai-SF-Request-Id: REQ-2026-0010`、件名は「【みらいSF】承認依頼 REQ-2026-0010 …」）。
- 監査ログ画面は承認者（管理者）では 4 行（受付・内容確認中・承認待ち・承認済み＋理由）を表示した。

## 7. 本番との差（重要）

| 項目                   | 本番（`00-adr.md` / `02-runbook.md` / `45`）                                                                                              | 今回の実測                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 認証経路               | Cloudflare Access（OTP）→ Worker → API。`AUTH_MODE=access`、`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` による JWT 検証（ヘッダ信頼は起動エラー） | `AUTH_MODE=password`。`/login` のメール＋パスワード。Access/JWT は未使用           |
| 到達経路               | `https://sf-prod.mirai-dx-platform.com`（Cloudflare Tunnel）。API は `127.0.0.1:8783`                                                     | `http://127.0.0.1:18996` へ直接（TLS なし、Access なし）                           |
| `NODE_ENV` / `APP_ENV` | `production` / `production`                                                                                                               | `test` / `test`                                                                    |
| Cookie                 | `Secure` 有効、SameSite=Lax                                                                                                               | `Secure` 無効（test 既定）                                                         |
| Origin 共有秘密        | `REQUIRE_ORIGIN_SECRET=1`                                                                                                                 | `0`（test 既定）                                                                   |
| メール                 | `MAIL_MODE=off`（本番既定）                                                                                                               | `MAIL_MODE=file`（ローカル送信 BOX）                                               |
| ログイン試行制限       | 有効（15 分 10 回）                                                                                                                       | `NODE_ENV=test` のため無効（`checkLoginRate`）                                     |
| ログアウト             | アプリ＋Cloudflare Access の両方を終える（`/cdn-cgi/access/logout`）                                                                      | アプリのみ終了し `/login` へ                                                       |
| DB                     | `mirai_sf_prod`                                                                                                                           | `mirai_sf_2acct_ui_20261118_test`（同一 migration 0017、実行後 drop）              |
| 画面                   | 本番配備の `dist/web`（`station.js`）。ソースは `bb7c2426`                                                                                | **同一ソース**（`18a297af` は docs のみ差分）。HEAD から再ビルドしバイト一致を確認 |

- 認可（`roleCanTransition`、自己承認拒否、理由必須、監査、注文書）はアプリのコードで決まるため、本番でも同じ規則が使われる。**ただし Access/JWT の認証部分は今回の実測に含まれない。**
- 本番では `/login` は Access の手前で表示されない（OTP 後にアプリへ入る）。今回の画面は「パスワードで `/login` に入る」経路であり、**ログイン画面そのものの本番動作は未検証**。
- 画面（`station.js`）は本番と同一ソース・同一ビルド経路だが、本番の配信物そのもの（配備済み `dist/web`）とバイト比較はしていない（本番ファイルへ触れないため）。

## 8. 未実施

- Cloudflare Access の **OTP ログインと JWT 検証経路**での実測（人間の OTP 受信が必要）。本番 URL・本番 API へのアクセス（healthz 含む）も未実施。
- 本番 DB・本番 API への書き込み、本番での業務実施。
- ボードの**ドラッグ&ドロップ**での状態変更（今回は主ボタンと旗アイコンで実施）。
- 差戻し → 再提出、取消・見送り、赤信号の承認、完了までの残り状態、承認前チェックの△の解消。
- 監査ログの CSV ダウンロード、一覧 CSV、DevOps への投入、データのエクスポート/インポート。
- 実メールの到達（`MAIL_MODE=file`。SMTP / sendmail は未使用）。
- モバイル幅・別ブラウザ（Chromium のみ。Firefox / WebKit / Safari は未実施）。
- 同時操作（2 人が同じ依頼を同時に開く）、連続大量操作、タイムアウト・ネットワーク断。
- 承認者 1 名が不在・無効化された場合の代替承認（エスカレーション）。

## 9. 残リスク

- **F-3（成功演出の先行）が最大の業務リスク**。本番の 2 アカウントはどちらも単一役割であり、利用者が「操作する人」で承認者を選ぶと、同じ誤認が起きる。サーバは拒否するが、画面は成功したように見える。運用で「右上の『操作する人』は変えない」を周知するか、受入前に修正するのが望ましい。
- **F-1 により、`42` §2 手順 5 の `order_version` 確認は画面でできない**。受入の判定基準を「DevOps の注文書 版、または API で確認」に読み替えるか、修正が必要。
- **F-6 により、「利用者名が正しい」ことは画面で確認できない**（役割は確認できる）。業務受入の記録項目を「役割」に寄せる必要がある。
- **認証経路の差（Access + JWT）は依然として最大の未検証領域**。Access のポリシー・許可リスト・JWT 設定のいずれかがずれると、アプリの認可が正しくてもログインできない。
- **F-4（自動反映なし）**のため、2 人が同時に作業すると古い状態を見る。受入では対象を開く前に読み直す。
- 承認者 1 名のため、不在・無効化時に承認が止まる（代替承認の仕組みは未確認）。
- 隔離 DB は drop 済みで、証跡は `/tmp/sf-ui-rehearsal/` に依存する（再起動・清掃で失われ得る）。
- 本番の `dist/web` と今回の再ビルド物のバイト比較はしていない（同一ソース・同一ビルド構成であることは確認済み）。

## 10. 証跡の置き場所（リポジトリ外）

`/tmp/sf-ui-rehearsal/` に保存した（リポジトリには入れていない）。パスワードは 0600 の `/tmp/sf-ui-rehearsal/.secret` だけに置き、本書・ログ・スクリーンショットには出していない。

| ファイル / ディレクトリ                         | 内容                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `shots/01〜33-*.png`                            | 手順ごとのスクリーンショット（33 枚）。主なものは §5・§6 に記載            |
| `evidence-ui.json`                              | 全ステップの判定・押した要素・表示・サーバ実測・コンソール・4xx/5xx の記録 |
| `order.yaml`                                    | 画面の「注文書」タブの YAML 全文（45 行、`order_version` なし）            |
| `order-api.json` / `order-api.yaml`             | サーバ `GET /api/requests/:id/order` の先頭と全文（`order_version: 1`）    |
| `logs/migrate.log` / `logs/seed.log`            | migration（0001〜0017、テーブル 30）と seed（部署 19 / 道具 118 / 見本 9） |
| `logs/users-setup.json`                         | 2 アカウントの作成結果（メールはマスク、ID・役割・有効状態）               |
| `logs/healthz.json`                             | 隔離 API の `/healthz`（`usersActive=2`、`mode=password`）                 |
| `logs/db-snapshot.txt` / `logs/db-verify.log`   | DB 直読（利用者・依頼・承認・監査）と `db.ts verify` 9/9 OK                |
| `logs/api.log` / `logs/api.pid`                 | API の起動ログ（5xx 0 件）と PID                                           |
| `logs/build-web.log` / `logs/dist-web-before.*` | `dist/web` の再ビルド記録と、再ビルド前の退避（tar.xz / md5）              |
| `logs/cleanup.log`                              | API 停止・ポート解放・DB drop の確認                                       |
| `mail/*.eml`                                    | `MAIL_MODE=file` の送信簿（承認依頼メール 1 通）                           |
| `setup-users.mts` / `rehearse.mjs`              | 実行したスクリプト（パスワードは埋め込んでいない）                         |

## 11. 再現手順と自動化スクリプト

### 11-1. 隔離環境の作り方（今回と同じ）

1. `createdb -h /var/run/postgresql mirai_sf_2acct_ui_20261118_test`
2. `DATABASE_URL='postgresql:///mirai_sf_2acct_ui_20261118_test?host=/var/run/postgresql'`、`NODE_ENV=test`、`APP_ENV=test`、`SEED_ADMIN_EMAIL=<承認者>`、`SEED_ADMIN_PASSWORD=<生成値>` を設定し、`pnpm -s exec tsx scripts/db.ts migrate` → `seed`（`scripts/local-run.mjs` は使わない）。
3. `APPROVER_EMAIL` / `REQUESTER_EMAIL` / 各パスワードを env で渡して `/tmp/sf-ui-rehearsal/setup-users.mts` を実行（`pnpm -s exec tsx`）。
4. `HOST=127.0.0.1 PORT=18996 NODE_ENV=test APP_ENV=test AUTH_MODE=password ALLOW_SELF_APPROVAL=0 MAIL_MODE=file MAIL_OUTBOX_DIR=/tmp/sf-ui-rehearsal/mail` と `DATABASE_URL` を設定して `./node_modules/.bin/tsx src/api/server.ts` を起動。
5. 画面を最新ソースに合わせる場合: `pnpm build:web`（`dist/` は gitignore 済み）。
6. `node /tmp/sf-ui-rehearsal/rehearse.mjs` を実行（ログは `logs/rehearse.log`、判定は `evidence-ui.json`）。
7. API を SIGTERM で停止 → ポート解放を確認 → `dropdb`。

### 11-2. スクリプトのパスと環境変数（本番へ向ける場合）

- **スクリプト**: `/tmp/sf-ui-rehearsal/rehearse.mjs`（Node + Playwright。リポジトリには入れていない）
- **環境変数**:

| 変数                                                 | 既定                                   | 意味                                                                 |
| ---------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| `BASE_URL`                                           | `http://127.0.0.1:18996`               | 接続先（本番は `https://sf-prod.mirai-dx-platform.com`）             |
| `STORAGE_STATE_REQUESTER` / `STORAGE_STATE_APPROVER` | なし                                   | 各役割の Playwright `storageState` JSON。あればログインを省略        |
| `STORAGE_STATE`                                      | なし                                   | 上 2 つの既定値（両方に同じセッションを使う場合）                    |
| `SECRET_FILE`                                        | `/tmp/sf-ui-rehearsal/.secret`         | パスワードのファイル（`storageState` 使用時は不要）                  |
| `EVIDENCE_DIR`                                       | `/tmp/sf-ui-rehearsal`                 | 証跡の出力先                                                         |
| `RUN_TITLE`                                          | `UI予行 2026-11-18 検索結果の表示改善` | 依頼の件名（本番は「業務受入 2026-11-xx …」等）                      |
| `APPROVER_EMAIL` / `REQUESTER_EMAIL`                 | 検証用の 2 名                          | ログインに使うメール                                                 |
| `RUN_LOGOUT`                                         | ローカルかつパスワードログイン時のみ 1 | ログアウト手順の実行/省略（`storageState` 利用時は既定で省略）       |
| `ALLOW_NON_LOCAL`                                    | 未設定                                 | ローカル以外へ向けるときの明示許可（誤爆防止。未設定なら起動しない） |

- **本番に向ける例**（所有者が手元でログインしたセッションを使う）:

```bash
ALLOW_NON_LOCAL=1 \
BASE_URL='https://sf-prod.mirai-dx-platform.com' \
STORAGE_STATE_REQUESTER=/path/requester.state.json \
STORAGE_STATE_APPROVER=/path/approver.state.json \
RUN_TITLE='業務受入 2026-11-xx 検索結果の表示改善' \
EVIDENCE_DIR=/tmp/sf-ui-rehearsal/prod \
node /tmp/sf-ui-rehearsal/rehearse.mjs
```

- `storageState` があれば `/login` を通らずにアプリへ入り、`/api/auth/me` で役割（`requester` / `approver`）を確認してから同じ順序を実行する。セッションが無効なら `/login` へ戻されるため、そこで FAIL して停止する。
- **注意（本番で実行する場合）**: このスクリプトは**依頼を 1 件作成し、承認まで進める（書き込み）**。本番で実行するかは所有者が決める。既定では `storageState` 利用時に**ログアウトしない**（提供されたセッションを壊さない）。ログアウトも測る場合は `RUN_LOGOUT=1` を明示する。

## 12. 後片付けの確認

- API: `tsx` の CLI（PID 23862）と node サーバ（PID 23900）へ SIGTERM を送り、`127.0.0.1:18995–18998` の待受が消えたことを `ss` で確認した。**別プロジェクトの `src/api/server.ts`（d4d-studio 系）には触れていない**（PID を path で確認してから停止した）。
- 隔離 DB: `dropdb` 後、`pg_database` に `mirai_sf_2acct_ui_20261118_test` が存在しないこと（count=0）を確認した。
- 既存 DB（`mirai_sf_prod` / `mirai_sf` / `mirai_sf_dev` / `mirai_sf_test` 等）と稼働中サービスへの接続・書き込み・再起動はしていない（DB 名の一覧確認のみ）。
- リポジトリ: 追跡ファイルの変更なし（`git status --short` は空）。`dist/web` は `.gitignore` 済みのビルド生成物で、HEAD のソースに合わせて再ビルドした（旧物は `/tmp` に退避）。**commit / push / PR / merge はしていない。**
- 本作業で追加したリポジトリファイルは本書 1 ファイルだけである。

## 13. 参照

- `42-business-acceptance-plan-20261113.md`（§2 手順、§3 合格条件）
- `44-two-account-verification-20261118.md`（2 アカウントの HTTP 実測。サーバ側の拒否は #4 `ERR-201` / #13 `ERR-105`）
- `45-auth-two-account-20261118.md`（2 アカウント化と desk 不在の読み替え）
- `36-release-readiness-20261113.md` §9（隔離 DB・ポート・E2E の進め方）、`38` / `39`（承認理由・画面修正）
- `46-release-bb7c2426-20261118.md`（本番配備）、`47-qa-update-20261118.md`（QA 状態）
- `src/web/public/station.js`（`canMove` / `applyStatus` / `toYAML`）、`src/shared/domain.ts`（`roleCanTransition` / `validateApproval`）、`src/api/app.ts`（`/`・`/login`・静的配信）、`src/api/auth.ts`（`createUser` / `setUserRoles` / `setUserActive` / `LocalAdminActor`）
