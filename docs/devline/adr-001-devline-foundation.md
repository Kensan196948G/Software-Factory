# ADR-001 開発ライン Phase 1 fake 縦断 PoC の土台

状態: 提案（Issue #14 の PoC 用） / 2026-10-31
対象: `db/migrations/0008_devline_foundation.sql`、`src/shared/devline.ts`、`docs/devline/api-contract.md`

作り物の承認済み依頼1件で「版固定 → 冪等 handoff → 永続 job → 計画 → fake 実装 → 検証証跡 → pr_ready」をつなぐ。到達点は `pr_ready` まで。実 PR・実 AI・実 GitHub・配備は作らない。完了の呼び名は「fake PoC」とだけする。

仕様の正本は `docs/みらいSF 詳細仕様書 V1.0.html`。この ADR は仕様の状態・ID・ERR の意味を変えない。AGENTS.md §1 は開発ライン本体を対象外としており、この PoC は Issue #14 による例外（U-10）。

## 1. 判断

| ID   | 判断                                                                                                                                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | job の状態は仕様 4-3 の15値だけ。受付12状態とは別の列で管理する。遷移表は `src/shared/devline.ts` を正本とし、DB は同じ表を関数に持つ。CHECK は OLD と NEW を比べられないので、BEFORE UPDATE トリガで遷移を拒否する。                                                                     |
| D-02 | ハッシュは「固定した YAML 本文」の sha256。保存した本文を正本とし、再生成して比べない（3章）。                                                                                                                                                                                            |
| D-03 | 新しい版を固定できるのは、依頼が `approved`、削除されていない、最新の approval が `approved`、`approval.order_version = request.order_version`、承認者が user id で分かる、信号の色が一致するときだけ。サービス層と INSERT トリガの両方で確かめる。                                       |
| D-04 | handoff は「intent を commit → claim して sent を commit → 外部呼び出し → 別トランザクションで確定」。外部 API の冪等キーを仮定しない。詳細は 4章。                                                                                                                                       |
| D-05 | 実行中の取消の行き先は `stopped`（`stop_reason=cancel_requested`）。仕様 4-3 で `cancelled` へ行けるのは `queued` からだけなので、遷移を足さない。取消は同じトランザクションで fencing を上げるので、遅れて届く worker の書き込みは捨てられる。                                           |
| D-06 | 再開先は、止まる直前の状態を `job.resume_to` に保存する。仕様は「人の指示で再開（resume）または終了」としか書いていないため、`stopped → {planning, implementing, verifying, revising, reviewing, closed}`、`failed → {implementing, closed}`、`cancelled → {queued, closed}` と解釈する。 |
| D-07 | worker は `request.status` を書きかえない。4-2 の対応は参照用の表（`JOB_STATE_REQUEST_STATUSES`）に留める。自動で動かすと、人の遷移の楽観ロック（`request.version`）とぶつかるため。                                                                                                      |
| D-08 | 実行者は `for update skip locked` で取得し、lease_owner / lease_expires_at / heartbeat_at / fencing_token を持つ。更新は必ず `where id=$ and fencing_token=$ and state=$expected`。rowCount 0 は例外にせず、捨てて `job_event` に残す。時刻は SQL に引数で渡す。                          |
| D-09 | devline の表から `request` への外部キーは `on delete restrict`。cascade にしても追記のみトリガが発火して失敗するので、消えない前提に揃える。既存の `delete from request` の2か所は Dev が対応する（5章）。                                                                                |
| D-10 | 上限は `devline-policy/v1` に定数化し、仕様 4-5（案）とセッション指示の厳しい側を採る（6章）。注文書の本文では上書きできない。                                                                                                                                                            |
| D-11 | Runner は `fake` のみ実装。`local-isolated` / `real` は型にだけ置き、起動時に拒否する。fake は `isolation: 'none'` を申告する。シナリオは注文書の本文から選ばせない。                                                                                                                     |
| D-12 | 検証証跡は in-process の `recordVerification()` で取り込む。API-07 の HTTP とサービス間トークンは認証モデルの変更なので別の Approval PR。合否は head_sha の中で最も新しい run の1件だけで決め、複数 run の寄せ集めをしない。`verification.source` に agent は無い。                       |
| D-13 | 旧ルート `POST /api/requests/:id/handoff` は応答の形を保ったまま、新しい処理へ委譲する。扉を2つにすると Issue が重複するため（7章）。                                                                                                                                                     |
| D-14 | 読み取りはログイン済みなら可（`getDetail` と同じ）。cancel / resume は desk / approver / admin。confirm_absent は approver / admin。`auth.ts` は変更しない（#27 と衝突させない）。admin は `actor.user.isAdmin`（`Role` に admin は無い）。                                               |
| D-15 | 新しい ERR 番号を作らない。既存の意味の範囲で足りる（`api-contract.md` 3章）。                                                                                                                                                                                                            |

### 検討した代替案

| 論点                 | 採用                                 | 退けた案                                    | 退けた理由                                                                                                     |
| -------------------- | ------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| ハッシュの対象       | 固定した YAML 本文                   | 正規化 JSON を hash する                    | Issue に載る本文と別の物を hash すると、照合で本文と結び付かない。時刻が混ざらないので JSON へ逃げる理由が無い |
| ハッシュの検証       | 保存した本文から再計算               | 依頼から YAML を再生成して比較              | 部署名・道具名・status で変わり、同じ版でも偽の不一致が出る                                                    |
| 実行中の取消         | `stopped(cancel_requested)`          | 実行中 → `cancelled` を遷移表に足す         | 仕様の状態遷移を変えることになる                                                                               |
| 取消の反映           | その場で状態を変え fencing を上げる  | 旗だけ立てて次の書き込みで解決する          | 旗が立ったまま worker が死ぬと取消が反映されない                                                               |
| 版を上げた時の Issue | 同じ Issue を PATCH                  | 版ごとに新しい Issue                        | IF-03 の「同じ Issue を更新」に反する                                                                          |
| request 削除との関係 | `on delete restrict`                 | cascade とトリガ内の `pg_trigger_depth`判定 | 取込やデモ初期化の連鎖で証跡が消える抜け道になる                                                               |
| 検証結果の持ち方     | 1配信1行、段階は JSONB               | 段階ごとの行                                | API-07 の入力が1配信に全段階を含み、段階を run 間で混ぜない規則と合う                                          |
| 費用の型             | `integer`（円）                      | `numeric`                                   | 端数を持たず、`db.ts` の型パーサの丸めにも左右されない                                                         |
| 照合の手段           | list API を `since` 付きでページ送り | search API                                  | search は索引遅れがあり「無い」と誤判定する                                                                    |

## 2. ENT-07〜10 との対応

| 仕様   | 実装                                                                             | 扱い                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ENT-07 | 既存の `approval`（変更しない）。`order_snapshot.approval_id` で結ぶ             | 「対象SHA／成果物ハッシュ」は `order_snapshot.content_sha256` と `base_sha` が担う。`approval.subject_hash` は使わない（U-08）                                                                                                     |
| ENT-08 | `job`。補助に `job_attempt`、`job_event`（追記のみ）、`job_artifact`（追記のみ） | 依頼ID・版＝`request_id`・`order_version`／状態＝`state`／計画＝`plan`／作業状態＝`work_state`／修正回数＝`repair_count_*`／時間＝`continuous_seconds`／費用＝`cost_jpy`／停止理由＝`stop_reason`・`stop_detail`・`remaining_work` |
| ENT-09 | `verification`（追記のみ・`delivery_id` unique）                                 | ジョブID・CI実行ID・段階ごとの合否（`stages`）・ログ（`log_ref`）・SHA。AC → test ID は `ac_results`、run・SHA・digest は同じ行が持つ。保持の 90 日は削除処理を作らないことで満たす                                                |
| ENT-10 | 作らない                                                                         | PR番号・配備・公開は Phase 1 の範囲外。PR 候補は `job_artifact(kind='pr_body_draft')` に置く                                                                                                                                       |

新しい補助の表 `order_snapshot`・`handoff_intent` は ENT に無い。仕様の ENT の項目は変えていない。

## 3. YAML の決定性とハッシュの正規化規則（確定）

### 確認した結果（`src/shared/order.ts` を読み、実際に動かした）

- `buildOrderYaml` は入力だけで決まる。`Date.now()`・乱数・環境変数を読まない。`formatOrderDate` は `Asia/Tokyo` 固定。
- 同じ `RequestRecord` から TZ=UTC / Asia/Tokyo / America/New_York / Pacific/Kiritimati で生成した固定用 YAML の sha256 は全部同じ（`ecf71662…fe67`）。
- ただし**入力のほうが同じ版のまま変わる**。再生成して比較すると偽の不一致が出る。

| 入力                           | 変わる場面                                    | 対応                                             |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------ |
| `status`（YAML の `status:`）  | approved → dev で文面が変わる                 | 固定時は承認済みに固定（`buildSnapshotYaml`）    |
| `suggested`（候補の色）        | カタログの色の変更で再計算の結果が変わる      | 承認記録の `suggested_signal` を使う（仕様 5-1） |
| 部署名・道具名                 | マスタの変更                                  | 固定時の本文を保存し、再生成しない               |
| `wish_date`                    | サーバの TZ で1日ずれる（下記の既存の不具合） | 同上。修正は別 Issue                             |
| 文字の表現（NFD/NFC）、単独 CR | 入力のしかた                                  | 正規化する                                       |

**既存の不具合（今回は直さない）**: `date` 列は node-pg がローカル時刻 0 時の `Date` にし、`repo.ts` の `mapRequest` が `toISOString().slice(0, 10)` で切る。実 DB の `date '2026-11-01'` が、JST と Kiritimati では `2026-10-31`、UTC と New York では `2026-11-01` になることを確認した。本番の TZ が JST なら希望時期が1日早く出る。直すと現行の YAML が変わるので別 Issue にする（U-01）。固定した本文には作成時の値がそのまま残る。

### 規則

1. **本文**: `canonical_yaml = canonicalizeOrderYaml(buildOrderYaml(固定した入力))`。形式は仕様 6-1 のまま。
2. **正規化**（この順）: Unicode NFC → `\r\n` を `\n` → 残った単独 `\r` を空白 → 末尾の改行をちょうど1つ。
3. **ハッシュ**: `content_sha256 = sha256(canonical_yaml の UTF-8 バイト列)` の小文字 16 進。DB の CHECK でも本文との一致を確かめる。
4. **一度だけ作る**: 固定は版ごとに1回。以後は保存した本文を読むだけで、依頼から再生成して比較しない。
5. **envelope**: `msf.order-envelope/v1`。`envelope_sha256 = sha256(canonicalJson(envelope))`。`canonicalJson` はキー順を固定し、文字列を NFC・LF にする。jsonb の往復でキー順が変わっても同じ値になる。
6. **計算する場所**: `src/shared` は web からも読むので `node:crypto` を入れない。API／worker 側で `createHash('sha256').update(text, 'utf8').digest('hex')` を使う。

試験用の固定値（T-14）:

| 入力                                               | 結果                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `a\r\nb\rc\n\n` の正規化                           | `a\nb c\n`                                                                       |
| 上の sha256                                        | `9ffaa0f83922d4eb11e56154814a41322108bebaefba1fe7f00c4fcebde5d5fc`               |
| `t: "が"\n`（NFD）の sha256                      | `0aa61c7c61e6ca2b5e25446f075a63630d0752acf5564ecb93f1b75c41619fac`（NFC と同じ） |
| `canonicalJson({b:1,a:{d:"が",c:[1,"x\r\ny"]}})` | `{"a":{"c":[1,"x\ny"],"d":"が"},"b":1}`                                          |

版の番号は連番ではない。承認後に編集すると +1、再承認でさらに +1 する（`updateRequest` と `performTransition`）。試験で「次の版は 2」と決めつけない。

## 4. IF-03 の解釈と handoff

仕様の記述は3か所ある。

- IF-03: 「受付番号＋版で同じ Issue を更新。混雑時は1・5・15分で最大3回再試行」
- 6-4: 「冪等キー: 受付番号＋注文書の版（同じ版を2回投入しても Issue は増えない）」
- API-06: 「承認済みのみ（受付番号＋版で冪等）」

**解釈**: 1依頼・1リポジトリに Issue は1つ。同じ版の再投入では何もしない。版が上がったら同じ Issue の本文を PATCH する。

| 場面                                | 動き                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 最初の投入                          | `op_kind=create_issue`                                                                                                            |
| 同じ版の再投入                      | 既存の結果を `created=false` で返す                                                                                               |
| 版が上がった後の投入                | `op_kind=update_issue`（`target_issue_no` = `request.issue_no`）。`request.issue_no` は1つのまま。版ごとの記録は `handoff_intent` |
| 古い版の投入                        | ERR-202                                                                                                                           |
| 前の版の create が sent / unknown   | 新しい版の作成を止める。先に前の版を照合する（部分 unique 索引でも保証）                                                          |
| 前の版の create が intent のまま    | 送っていないと確定できるので `failed` にして、新しい版で作成                                                                      |
| 新しい版の job ができた時の古い job | `queued` → `cancelled`、実行中 → `stopped(order_superseded)`、`pr_ready` 以降は状態を変えず `superseded_at` を入れる              |

**応答の分類**（`classifyIssueResponse`）

| 応答                            | 分類           | 意味                                                                        |
| ------------------------------- | -------------- | --------------------------------------------------------------------------- |
| 2xx で本文が読める              | `succeeded`    |                                                                             |
| 2xx で本文が読めない            | `unknown`      | 作成済みかもしれない                                                        |
| 時間切れ・接続断・408・3xx・5xx | `unknown`      |                                                                             |
| 429、Retry-After 付きの 403     | `rate_limited` | 未処理とみなす。state は `failed`、`next_attempt_at` を 1・5・15 分後に設定 |
| その他の 4xx                    | `failed`       | 作られていない。同じ行で再度送ってよい                                      |

**照合**

- `unknown` と、`sentStaleMs`（120秒）を過ぎた `sent` は、list API（`state=all`、`since`＝intent 作成の5分前、ページ送り）でマーカーを探す。これより新しい `sent` は別の処理の最中とみなして触らない（ERR-301）。
- `since` は更新時刻で絞る API だが、作成された Issue の更新時刻は必ず作成時刻以降なので取りこぼさない。
- マーカーは本文の**1行目**に完全一致するものだけ。注文書の本文に同じ文字列があっても一致しない。
- **リポジトリが公開なので、第三者が同じマーカーの Issue を作れる**。PR を除き、作成者が連携アカウント本人のものだけを見る（`matchIssueByMarker`。ブリーフからの追加）。
- 上限ページを超えたら「不完全」とし、`confirm_absent` があっても再作成しない。
- create は、走査が完全で見つからず、権限者が `confirm_absent` を理由付きで明示したときだけ再作成する。update は同じ本文の PATCH なので自動で再送するが、最新の版に限る。

**送ってよい条件**: 外部へ送るのは、その版が依頼の最新の版で `isOrderCurrent` が真のときだけ（`nextHandoffAction` の `sendAllowed`）。既存の intent を再送する場合も同じで、古い版の PATCH が新しい版を上書きすること、差戻しや取消の後に Issue を作ることを防ぐ。照合は読み取りなので行ってよい。

**確定の順序**: 外部の Issue が存在する事実は、依頼の状態にかかわらず記録する（`request.issue_no` も入れる。入れないと次の版が重複を作る）。job は依頼がまだ有効なときだけ作る。

**混雑時の再試行**: Phase 1 の handoff は同期の API なので自動では再試行しない。`next_attempt_at` より前の再投入を ERR-302 で断る（U-14）。

## 5. 依頼の削除との関係（D-09）

`delete from request` を実行するコードが2か所ある。devline のデータがあると外部キーで失敗し、何もしなければ ERR-401 になる。

| コード                      | 対応（Dev）                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resetDemo`（本番では拒否） | 先に `truncate table verification, job_artifact, job_event, job_attempt, job, handoff_intent, order_snapshot` を実行する。`db.ts reset` が audit_log を truncate するのと同じ扱い |
| `importAll`（全置換）       | devline の行があれば ERR-201 で断り、理由を示す。証跡を取込の連鎖で消さない                                                                                                       |

`db.ts reset` と `truncateBusiness` は `truncate ... cascade` なので変更不要（行トリガは発火しない）。

## 6. 実行上限（`devline-policy/v1`）

| 種類                     | 仕様 4-5（案） | 採用       | 達したら                                   |
| ------------------------ | -------------- | ---------- | ------------------------------------------ |
| 同じ原因の修正           | 3回            | **2回**    | `stopped(same_cause_limit)`                |
| 修正の合計               | 6回            | **5回**    | `stopped(repair_total_limit)`              |
| 1セッション              | 60分           | 60分       | `stopped(session_limit)`                   |
| 連続作業                 | 2時間          | 2時間      | `stopped(continuous_limit)`                |
| 同じコミットの CI 再実行 | 2回            | 2回        | `stopped(ci_rerun_limit)`                  |
| 費用                     | 5,000円        | 予算未設定 | 実 AI を動かさない。fake は 0 円で計上だけ |

原因のキーは CI の結果（段階と test ID）から作り、Agent の申告を使わない。修正回数は新しい版の job でだけ戻る（再承認でリセットという仕様どおり）。回数切れで止まった job は再開できない。

## 7. 旧ルートの互換（D-13）

| 項目                                            | 変更前                 | 変更後                                                                       |
| ----------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| 応答の形 `{issueNo, issueUrl, created, detail}` | あり                   | 同じ                                                                         |
| `issue_no` 済み                                 | `created:false` で返す | 同じ。新しい処理を呼ばない                                                   |
| GitHub 未設定                                   | ERR-405 / 409          | 同じ（仕様の 500 との差は既存のまま。U-15）                                  |
| 接続できない                                    | ERR-304 / 502          | 同じ（時間切れも ERR-304 に揃える）                                          |
| 権限                                            | desk / approver        | 同じ                                                                         |
| **`issue_no` 未設定で status が dev 以降**      | Issue を作った         | **ERR-205 に狭まる**（版固定は approved でしかできない）                     |
| **承認記録に user id が無い（見本データ）**     | Issue を作った         | **ERR-205 に狭まる**                                                         |
| 副作用                                          | Issue のみ             | intent・snapshot・job も作る。worker が動いていなければ job は queued のまま |

狭まる2点は、版固定の要件から来る意図した変更。Staging の見本データでは「GitHub Issueを作成」が ERR-205 になるので、PR の既知の制限に書く（U-04）。

## 8. 受付12状態と job 状態の対応（仕様 4-2）

対応は参照用で、どちらかがもう一方を動かすことはない（D-07）。

| 受付の状態                  | 工程            | とりうる job の状態                                    | 備考                                                      |
| --------------------------- | --------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `received` 受付             | －              | なし                                                   | ラインに入っていない                                      |
| `review` 内容確認中         | －              | なし                                                   | 同上                                                      |
| `wait` 承認待ち             | －              | 新規なし。既存は `order_invalidated` で止まる          | 承認後の編集、`dev → wait` でここへ戻る                   |
| `approved` 承認済み         | L1              | `queued`（Phase 1 では `pr_ready` まで進むことがある） | 受付は人が動かすので、job だけ先に進む                    |
| `dev` 実装中                | L2〜L6          | `planning` `implementing` `verifying` `revising`       | job の `verifying` は L5 の CI なので受付の検証中ではない |
| `verify` 検証中             | L7〜L9（＋L10） | `pr_ready` `reviewing` `approved` `merged` `staged`    |                                                           |
| `field` 現場試用            | L10             | `merged` `staged`                                      | 現場向けの道具のみ                                        |
| `release_wait` 公開承認待ち | L11 の手前      | `staged`                                               |                                                           |
| `done` 完了                 | L11 完了        | `released` `closed`                                    |                                                           |
| `back` 差戻し               | －              | 新規なし。既存は `order_invalidated` で止まる          |                                                           |
| `hold` 見送り               | －              | 同上                                                   |                                                           |
| `cancel` 取消               | －              | 同上                                                   | 依頼の取消は job を直接は動かさない。worker が検知        |

`stopped` `failed` `cancelled` は受付を動かさない。worker は工程ごとに `isOrderCurrent` を確かめ、無効なら `stopped(order_invalidated)` にする。`pr_ready` で待っている job は worker が触らないので、`GET` の `orderCurrent=false` で示す。

## 9. job の状態遷移表（仕様 4-3）

| 状態           | 次の状態                                                              | Phase 1 で動かす主体              |
| -------------- | --------------------------------------------------------------------- | --------------------------------- |
| `queued`       | `planning` `cancelled`                                                | worker／人（取消）                |
| `planning`     | `implementing` `stopped`                                              | worker                            |
| `implementing` | `verifying` `stopped` `failed`                                        | worker                            |
| `verifying`    | `pr_ready` `revising` `stopped`                                       | `recordVerification`（CI の結果） |
| `revising`     | `verifying` `stopped`                                                 | worker                            |
| `pr_ready`     | `reviewing` `approved`                                                | Phase 1 では動かさない（到達点）  |
| `reviewing`    | `approved` `revising` `stopped`                                       | Phase 1 では到達しない            |
| `approved`     | `merged`                                                              | 同上                              |
| `merged`       | `staged`                                                              | 同上                              |
| `staged`       | `released`                                                            | 同上                              |
| `released`     | `closed`                                                              | 同上                              |
| `closed`       | なし                                                                  |                                   |
| `stopped`      | `planning` `implementing` `verifying` `revising` `reviewing` `closed` | 人のみ（`resume_to` へ）          |
| `failed`       | `implementing` `closed`                                               | 人のみ                            |
| `cancelled`    | `queued` `closed`                                                     | 人のみ                            |

`isPhase1Transition` はこの表より狭く、`pr_ready` から先と `closed` を実行させない。

`handoff_intent.state` の遷移は `intent → sent|failed`、`sent → succeeded|unknown|failed`、`unknown → succeeded|sent`、`failed → sent`、`succeeded` は終わり。これは ENT-08 の状態ではない補助フィールド。

## 10. 未確定事項

| ID   | 内容                                                                                                                 | 今の扱い                                                                   | 決める人     |
| ---- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------ |
| U-01 | `wish_date` の1日ずれ（3章）                                                                                         | 別 Issue。この PR では直さない                                             | CTO          |
| U-02 | `pr_ready` の job の取消。仕様に停止の行き先が無い                                                                   | ERR-201 で断る。版が上がれば `superseded_at`                               | 仕様の責任者 |
| U-03 | 「終了」（`closed`）の操作。仕様にはあるが依頼に API が無い                                                          | 遷移表にだけ置く。止まった job はそのまま残る                              | CTO          |
| U-04 | 旧ルートが狭まる2点（7章）                                                                                           | 意図した変更として PR に明記                                               | CTO          |
| U-05 | 上限の値は Q-05 で確定する案                                                                                         | 定数のまま。版は `devline-policy/v1`                                       | Q-05         |
| U-06 | IF-03 の GitHub App／Webhook、6-4 のラベル                                                                           | 既存の token 方式を維持。ラベルは付けない                                  | Phase 2      |
| U-07 | 実 runner の `changedPaths` の出どころ。申告を信じず git の差分から出す必要がある                                    | fake は作業ディレクトリから算出                                            | Phase 2      |
| U-08 | `approval.subject_hash` は未使用のまま。承認時点の本文のハッシュは残らず、固定は承認後の投入時に行う                 | 承認後に内容を変えると版が上がるので検知できる                             | Phase 2      |
| U-09 | 証跡の保持期限と削除の手順                                                                                           | 削除処理を作らない                                                         | Q-09 ほか    |
| U-10 | AGENTS.md §1 と `docs/limitations.md` の「開発ライン本体は対象外」                                                   | PoC の PR で limitations を更新するか判断                                  | CTO          |
| U-11 | 赤信号（`signal_decided='r'`）の承認済み依頼。BR-03 は範囲を変えてから承認とするが、赤のまま承認する操作は既存にある | handoff は通し、worker は計画の段階で `stopped(red_signal_human_required)` | 仕様の責任者 |
| U-12 | 職務の分離（ERR-105）と AI の自己承認                                                                                | `pr_ready` までなので今回は発生しない                                      | Phase 2      |
| U-13 | 正本の `docs/orders/REQ-….yaml` と 4-6 の記録のリポジトリ保存                                                        | DB の `work_state` のみ。Git には書かない                                  | Phase 2      |
| U-14 | IF-03 の 1・5・15 分の自動再試行                                                                                     | 時刻だけ記録し、人の再投入で再試行                                         | Phase 2      |
| U-15 | ERR-405 の応答が既存は 409、仕様は 500                                                                               | 既存のまま                                                                 | 仕様の責任者 |

## 11. 実装で確定・変更したこと（Dev）

### CTO の追加決定

| ID   | 決定                                                                                                                                                                                                                                      | 影響                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| C-01 | 許可リストは `DEVLINE_TARGET_REPOS`（`owner/name:repoId` のカンマ区切り）。**既定は空で投入をすべて拒否**。`GITHUB_REPO` を暗黙の許可先にしない。形の違う値は起動時に例外。リポジトリが公開で、注文書 YAML に依頼者欄・承認者欄が載るため | 契約の `DEVLINE_ALLOWED_REPOS`（未設定なら `[targetRepo]`）を置きかえる。対象は従来どおり `GITHUB_REPO` で、許可リストに載っていなければ ERR-405 |
| C-02 | U-04（旧ルートが一部 ERR-205 になる）を受け入れる。既知の制限として `docs/limitations.md` に書く                                                                                                                                          | 7章の2点に加え、許可リストが空のあいだ旧ルートの新規投入は ERR-405（下記）                                                                       |
| C-03 | 修正の上限は同因2回・合計5回（`DEVLINE_POLICY` の定数）                                                                                                                                                                                   | 6章のとおり                                                                                                                                      |
| C-04 | `auth.ts`・UI を変更しない。API-07 の HTTP とサービス間トークンを作らない                                                                                                                                                                 | D-12・D-14 のとおり                                                                                                                              |

### 旧ルートが狭まる3点目

`GITHUB_TOKEN` と `GITHUB_REPO` が設定済みでも、`DEVLINE_TARGET_REPOS` が空なら新規投入は ERR-405（409）になる。`issue_no` 済みの依頼が `created:false` を返す動きは読み取りだけなので従来どおり。

### 契約への追加

| 変更                                                                                                             | 理由                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IssueAdapter.getRepoId`、`DevlineDeps.allowedRepos` を `AllowedRepo[]`（`{name, repoId}`）に変更                | 許可リストの `repoId` を意味のあるものにする。送信の直前に `GET /repos/{owner}/{name}` の `id` と照らし、不一致は ERR-405。名前の付け替えや譲渡で別のリポジトリへ送らないため。`target_repo_id` の列は `owner/name` のまま |
| `DevlineDeps.httpTimeoutMs`（省略可）、`handoffOrder` の `deps` を省略可、`buildApp({ devlineDeps })`            | `config` は import 時に固まるので、試験で依存を差し替える口が要る。省略時は呼び出しごとに `defaultDevlineDeps()` を作る                                                                                                    |
| `transitionJob` / `haltJob` の `actor`（省略可）、`closeAttempt`、`heartbeat` の `leaseSeconds`（省略可）        | runner の結果による遷移を監査に `agent` で残すため。結果が出なかった試行（時間切れ・取消）を閉じるため                                                                                                                     |
| `src/api/devline-service.ts` は入口のみ。実体は `devline-handoff.ts` `devline-jobs.ts` `devline-verification.ts` | 大きさのため。import は入口からでよい                                                                                                                                                                                      |
| `recordVerification` の `advanced` は「状態を動かした、または fence を上げて lease を外した」の意味              | `incomplete` の再実行は状態が同じでも lease が外れる。worker はこの値で `releaseLease` の要否を決める。`job` を先に `for update` してから `verification` を入れる（外部キーのロックからの昇格でデッドロックしないように）  |
| 3xx を追わない（`redirect: 'manual'`）                                                                           | token を付けたまま別の場所へ送らない。書き込みの 3xx は 4章どおり `unknown`                                                                                                                                                |
| `GITHUB_API_URL` は https かループバックのみ（試験はループバックのみ）                                           | 平文で token を外へ出さない                                                                                                                                                                                                |

### 契約に無かった経路

| 場面                                                  | 実装                                                                                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前の版の create が `unknown` のまま照合で見つからない | 新しい版の投入に `confirm_absent` があり走査が完全なら、前の版を `unknown → sent → failed`（外部へは送らない。遷移表どおり）で閉じ、`confirmed_absent_*` と監査を残して新しい版で作成する。無いと永久に投入できない |
| 前の版の update が `sent` のまま残る                  | 前の版は ERR-202 で再投入できず、`handoff_intent_one_inflight_idx` が新しい版を止め続ける。`sentStaleMs` を過ぎたら `unknown` にする。新しい版の PATCH が本文を上書きするので照合しない                             |
| 別のリポジトリへ成功済みの依頼                        | `request.issue_no` は1つなので、対象を変えると無関係な Issue を上書きしうる。ERR-405 で断る                                                                                                                         |
| AC の ID                                              | `AC-1` 形式を `request.criteria`（空行を除く）から作る。criteria は版が上がらない限り変わらず、状態を動かすのは版が最新のときだけなので、版固定の本文と食い違わない                                                 |

### 時間の数え方（`continuous_seconds`）

契約のままでは `continuous_seconds` を増やす処理が無く、`continuous_limit` に届かない。

- **session**: 取得で始まり（`session_started_at`）、lease を外すときに閉じる（`releaseLease`、`haltJob`、`recordVerification` など）。閉じるときに経過を `continuous_seconds` へ足し、`session_started_at` を null に戻す。仕様 4-5 の「1セッション60分。超える前に作業状態を保存して次のセッションで再開」を、Phase 1 では1工程＝1セッションとして読む。
- **連続**: `continuous_seconds`（閉じた session の合計）＋いまの session の経過。人の再開で 0 に戻る（契約どおり）。工程と工程のあいだの待ち時間は作業に数えない。
- lease が切れて取り直した場合は `coalesce` で session が続くので、落ちた worker の経過も session に数える。

### その他の確定

- `decided_signal` の表示は Issue 本文では固定時の `envelope` の値を使う。承認者名・部署名・タイトルは送信時の依頼の値（版が上がらない限り変わらない。部署名だけはマスタの変更で変わりうるが、YAML は固定した本文のまま）。
- 仕様 6-4 の 7「原本の保護」は「写真・記録を扱わなければ対象外」なので、契約の「現場向けでなければ 6・7 は対象外」のうち 7 は `data_handling` の `photo` で判定する（仕様を優先）。

## 12. 修復ループ1回目（QA・Security の指摘と CTO の裁定）

| ID      | 変更                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B-1     | 人の再開で `work_state.resumeEpoch` を +1 する。fake CI の配信 ID に `:r{epoch}` を足し、`run_attempt = epoch + 1` にする（再開前の配信と重ねず、新しい試行が最新になる）。進まなかった工程は session を閉じないので、結果を待ち続ける job も `session_limit` で止まる。`claimNextJob` は `updated_at, created_at` の順にして、待っている job が他を止めないようにする（契約の SQL からの変更）。worker は進まなかった工程の後も待つ |
| B-2     | 状態を動かすのはその SHA の最新の記録（`run_sequence, run_attempt` が最大）の配信だけ。古い配信は記録するだけで再実行を数えない                                                                                                                                                                                                                                                                                                      |
| B-3     | lease の持ち主の書き込みすべてに `lease_owner=$owner` を足す。外した lease は `applied:false`                                                                                                                                                                                                                                                                                                                                        |
| B-4     | `ci_rerun_limit` を `NON_RESUMABLE_STOP_REASONS` に足す                                                                                                                                                                                                                                                                                                                                                                              |
| B-5/M-2 | `src/shared/{devline,domain,order}.ts`、`src/worker/**`、`src/api/devline-*`、`issue-adapter*`、`{github,service,app,http,audit,db}.ts` を禁止に足す。`tests/` は `tests/generated/` 以外を `human_approval_required`。差分が無いので新規か既存かを置き場で決める                                                                                                                                                                    |
| B-6     | `.envrc`、`*.env`、`.secrets/` を禁止に足す                                                                                                                                                                                                                                                                                                                                                                                          |
| B-7     | 別のリポジトリに `sent` / `unknown` の投入が残る依頼は、対象を変えても作らない。ERR-405（`details.handoffState='unknown'`）                                                                                                                                                                                                                                                                                                          |
| B-8     | `transitionJob` は `pr_ready` へ進めない。`0009` の `job_guard` が、最新の記録の必須段階すべての passed と `pr_body_draft` を要求する（`check_violation`）。`recordVerification` は PR 候補を先に作る                                                                                                                                                                                                                                |
| H-1     | Issue 本文の値を1行のインラインコードにする（`inlineCode`）。承認者欄は `approval.approver_name`。タイトルは `safeIssueTitle` で1行にして 通知やリンクになる記号（@ < > [ ] と backtick）を全角へ置きかえる                                                                                                                                                                                                                          |
| H-2     | 送る前に `IssueAdapter.getRepoPrivate` を確かめ、公開リポジトリは常に ERR-405。読めなければ ERR-304。例外の設定は作らない                                                                                                                                                                                                                                                                                                            |
| M-1     | PATCH の前に対象の Issue を読み、PR でない・作成者が連携アカウント・1行目のマーカーの依頼 ID とリポジトリが一致、を確かめる。不一致は送らずに ERR-405                                                                                                                                                                                                                                                                                |
| M-3     | 許可の判定は小文字化しない（禁止の判定は小文字化する）。Runner の結果を `src/worker/runner-result.ts` で実行時に検証し、`kind` を制限する（`pr_body_draft` は作れない）                                                                                                                                                                                                                                                              |
| M-4     | 赤信号は `envelope.approval.decided_signal` で判定する。worker は Runner を呼ぶ前、`resumeJob` は ERR-201、`recordVerification` は `stopped`。`queued` には `stopped` への遷移が無いので `planning` を経て止める（T-70。Runner は呼ばない）                                                                                                                                                                                          |

### 残した課題

- **`changedPaths` の出どころ（M-3 の残り・U-07）**: fake は runner の申告をそのまま使う。実 runner（`docs/devline/real-runner.md`）は `src/worker/diff-policy.ts` で git の差分から算出し、試験の新規と既存を差分の状態で区別する。
- **旧来の Issue**: マーカーの無い Issue（`request.issue_no` はあるが PoC 以前に作られたもの）は M-1 により PATCH されない（ERR-405）。
