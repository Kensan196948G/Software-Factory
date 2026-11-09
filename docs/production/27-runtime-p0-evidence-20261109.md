# ランタイム P0 実行証跡（2026-11-09）

作成: 2026-11-09 JST。状態: **実行証跡**（合否の判定ではない）。
時刻はすべて JST。実行したのは分離 DB（`mirai_sf_test`）とローカルの API、および GitHub Actions の CI だけで、本番・Staging・Cloudflare の状態は変えていない。

## 0. 証跡の置き場所

生ログはリポジトリ外の `~/.local/state/mirai-sf/evidence/` に置く（追跡対象外。secret は含まない）。本書の数値は生ログから転記した。

| 実行                     | 生ログ                                | sha256                                                             |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------ |
| 統合テスト（08:28 開始） | `integration-20261109T0828.log`       | `4de1f4433d3f05a668ac4ba129c350185afaad6daa334755191224d695c469aa` |
| 単体テスト（10:02 開始） | `unit-20261109T100244.log`            | `5822f99d0f23c3e1014ec500a148ec2f7e6c38200a4cf2d765cfc9f209ddc010` |
| レート制限（10:02）      | `rate-limit-body-20261109T100216.log` | `6f3fb2833228dbbf626eee62dcdb61d7539a35b2d91dd4d3361eb65c23a09814` |

CI の e2e は GitHub Actions のジョブログが証跡である（run `42537665728`、head `2a02024f`）。

## 1. 目的と範囲

- 品質工作台のリリース判定（NO-GO）で不足していた**ランタイム P0 の実行証跡**を記録する。
- 対象は未実行だった P0 19 件（TC-AUTH-01/02、TC-AUTHZ-01、TC-REQ-01/02/03、TC-FLOW-01、TC-APPROVE-01/02/03、TC-ORDER-01、TC-AUDIT-01、TC-DEVLINE-01/02、TC-HEALTH-01、TC-ACCESS-01、TC-UI-STATE-01、TC-CONCURRENCY-01、TC-RATE-01）。
- **この文書は証跡であり、テストケースの合否を判定しない。** TC を `executed` にするかどうかは品質工作台（dsh-qa）で判断する。
- 引用したテスト名はすべて HEAD のテストソースに実在することを grep で確認した（2026-11-09 10:01 JST）。

## 2. 実行環境と条件

| 項目          | 値                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実行 HEAD     | 統合は `dbfede1e`（08:28 実行時）、単体とレート制限は `2a02024f`（10:02 実行時）。両者の差は `AGENTS.md`・`README.md`・`docs/` のみで、`src/`・`tests/`・`db/` は同一 |
| 実行日時      | 統合 2026-11-09 08:28:17〜08:42:20（843.30 秒）／単体 10:02:45〜10:03:24（38.67 秒）／レート制限 10:02:16〜10:02:18                                                   |
| CI の e2e     | run `42537665728`（`2a02024f`、2026-11-09 09:09 JST 前後）。**161 passed / 1 skipped**（13.6 分）                                                                     |
| Node / pnpm   | Node v22.22.3 / pnpm 12（プロジェクトの指定どおり）                                                                                                                   |
| DB            | `mirai_sf_test`（既存のテスト DB。DB の作成・DROP はしていない）                                                                                                      |
| API           | レート制限の確認のみ、`127.0.0.1:18999` で一時起動（`NODE_ENV=development`・`AUTH_MODE=password`・`MAIL_MODE=file`）                                                  |
| 本番・Staging | 参照も変更もしていない（Staging の自動追従は別の運用で動いている）                                                                                                    |

## 3. 実行結果サマリ

| 実行                     | コマンド                                        | 結果                                                                            | 証跡                             |
| ------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| 統合テスト               | `pnpm test:integration`                         | **24 ファイル / 780 テスト pass**、exit 0、843.30 秒（08:28:17 開始）           | 生ログ（§0）                     |
| 単体テスト               | `pnpm test:unit`                                | **38 ファイル / 974 テスト pass**、exit 0、38.67 秒（10:02:45 開始）            | 生ログ（§0）                     |
| ログイン試行のレート制限 | 一時 API に誤ったパスワードで 11 回ログイン     | 1〜10 回目 **401（ERR-106）**、11 回目 **429（ERR-302）**。`Retry-After` は無し | 生ログ（§0）                     |
| CI の e2e                | `pnpm exec playwright test`（CI の e2e ジョブ） | **161 passed / 1 skipped**（13.6 分。`tests/e2e/console.spec.ts` を含む）       | GitHub Actions run `42537665728` |

単体テストは**補助証跡**である。純関数・設定・運用スクリプトの健全性は示すが、API・DB・UI の動作やリリース可否を証明しない。

## 4. テストケースとの対応

「実行証跡の範囲」は TC の合否ではない。**実行済み**は引用したテストが pass したこと、**一部**は TC の条件の一部が未検証、**期待と差分**は実測が TC の期待と異なることを示す。

| TC                | 内容                                                        | 主な証跡（テストファイル / テスト名）                                                                                                                                                                                                                                    | 実行証跡の範囲                                                                                                    |
| ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| TC-AUTH-01        | ログイン成功・失敗・無効化後のセッション失効                | `tests/integration/api.test.ts`「ログインに成功するとユーザーとCSRFトークンを返す」「パスワードが違うと401（理由は区別しない）」「期限切れのセッションは401」／`tests/integration/separation.test.ts`「無効化した利用者はログインできず、既存のセッションも使えない」    | 一部（Cookie の HttpOnly・SameSite 属性と、ログイン失敗の監査記録は、引用したテストでは確認していない）           |
| TC-AUTH-02        | CSRF 欠落・不一致・不正 Origin の拒否                       | `tests/integration/api.test.ts`「更新系はCSRFトークンがないと403」                                                                                                                                                                                                       | 一部（不正 Origin の拒否は専用テストが無い）                                                                      |
| TC-AUTHZ-01       | 役割別の遷移許可と 403（承認は承認者のみ）                  | `tests/integration/api.test.ts`「受付担当は承認できず、承認者が信号を決めて承認できる」／`tests/integration/separation.test.ts` の管理 API 403・自己承認 403 の各テスト                                                                                                  | 期待と差分（受付担当の承認拒否は **409 / ERR-201**。TC の期待は 403。403 は管理 API・自己承認では確認）           |
| TC-REQ-01         | 受付登録・年別採番・連番の一意性                            | `tests/integration/api.test.ts`「受付番号を採番し、履歴に「受付」を残す」（`^REQ-\d{4}-0001$` と履歴 `受付`）／同「接続プールを超える同時の作成でも詰まらない」（25 並列がすべて 201）                                                                                   | 一部（年跨ぎの 0001 と、複数件での連番の一意性は明示テストが無い）                                                |
| TC-REQ-02         | Idempotency-Key による同一応答と内容違い 409                | `tests/integration/api.test.ts`「同じ冪等キー・同じ内容なら同じ依頼を返す」「同じ冪等キーで内容が違うと409 ERR-008」「作成後にマスタが変わっても、同じキーの再送は作成済みの依頼を返す」                                                                                 | 実行済み                                                                                                          |
| TC-REQ-03         | 受付入力の境界値                                            | `tests/integration/api.test.ts`「合格の条件が9件なら400 ERR-006」「件名が60文字を超えると400」「カタログ外の道具IDは400」「部署と合わない道具は ERR-013（400）」                                                                                                         | 実行済み                                                                                                          |
| TC-FLOW-01        | 12 状態の遷移表・理由必須・楽観ロック                       | `tests/unit/domain.test.ts`「状態遷移（本番の遷移表）」の「定義された遷移だけ許可する」／`tests/integration/api.test.ts`「古い版番号での更新は409 ERR-301」「受付から承認済みへ直接は409」「差戻しは理由必須」「取消は論理削除で、一覧から外れる」                       | 実行済み                                                                                                          |
| TC-APPROVE-01     | 承認前チェックの△と承認拒否（ERR-203）                      | `tests/integration/api.test.ts`「候補よりゆるい色は理由が必要（ERR-102）」／同「受付担当は承認できず、承認者が信号を決めて承認できる」のうち ERR-203 の検証（信号を決めずに承認すると 400）                                                                              | 実行済み（ERR-203 は専用テストではなく承認フローのテスト内で確認）                                                |
| TC-APPROVE-02     | 自己承認の環境別挙動と監査警告                              | `tests/integration/separation.test.ts`「自己承認の拒否（ERR-105）」と「開発既定（ALLOW_SELF_APPROVAL=1）では従来どおり自己承認できる」                                                                                                                                   | 実行済み                                                                                                          |
| TC-APPROVE-03     | 二重承認の拒否（同一版 409 / 最新版 409）                   | `tests/integration/separation.test.ts`「二重承認は拒否し、拒否の理由も監査に残す（同時・再送の両方）」                                                                                                                                                                   | 実行済み                                                                                                          |
| TC-ORDER-01       | 注文書 YAML の取得条件・決定性・版                          | `tests/integration/api.test.ts`「承認済みなら注文書YAMLを生成できる（未承認は409 ERR-205）」／`tests/unit/output.test.ts`「先頭に schema_version と order_version を持つ」「空のリストは [] で出す」「改行は空白に置きかえ、引用符をエスケープする」                     | 実行済み                                                                                                          |
| TC-AUDIT-01       | 監査ハッシュ連鎖・改ざん検知・UPDATE/DELETE 拒否            | `tests/integration/api.test.ts`「監査ログはハッシュ連鎖が壊れていない」「監査ログは管理者だけが読める」「監査ログをCSVで書き出せる（管理者のみ）」／`db/migrations/0001_init.sql` の `audit_log_no_update` トリガ（before update or delete）                             | 一部（`audit_log` の UPDATE/DELETE 拒否と改ざん検知は専用テストが無い。追記専用テーブルの拒否は T-04 で確認済み） |
| TC-DEVLINE-01     | handoff の許可外・公開リポジトリ拒否と冪等                  | `tests/integration/devline-qa-handoff.test.ts`「T-21: 同じ版の再投入で Issue が増えず created=false」「T-22: 5並列の投入で Issue は1つ」「T-93: 同じ POST の再実行で監査・履歴が増えない」／`tests/integration/devline-target-selection.test.ts`                         | 実行済み                                                                                                          |
| TC-DEVLINE-02     | AC 未確認の非合格・人の承認・agent 拒否・二重押下           | `tests/integration/devline-qa-verify.test.ts`「未知の status や空の段階を passed に数えない」「同じ段階が passed と skipped の両方なら悪い方（合格にしない）」「同じ配信を並行で5回送っても記録は1件」／`tests/integration/devline-ac-gui.test.ts`                       | 実行済み                                                                                                          |
| TC-HEALTH-01      | healthz の usersActive と外形監視の失敗判定                 | `tests/integration/healthz-auth.test.ts`「usersActive は無効な利用者を数えない」「本番相当で JWT 未設定・ヘッダ信頼無効なら 200 のまま misconfigured」／`tests/unit/healthcheck-offsite.test.ts`「古い: ローカル dump が新しくても、送信記録が閾値より古ければ NG」      | 実行済み                                                                                                          |
| TC-ACCESS-01      | Access JWT の fail-closed と最小権限の自動登録              | `tests/integration/access-jwt.test.ts`「ヘッダのメールだけでは401」「改ざんした JWT は401（500にしない）」「本番では未登録の利用者を自動登録しない」「サービストークンは common_name が許可リストにあるときだけ通る」                                                    | 実行済み（実 JWT での E2E は未実行。C3 の資格情報待ち）                                                           |
| TC-UI-STATE-01    | 主要画面の 5 状態（空・読込・入力エラー・通信エラー・成功） | CI の e2e（run `42537665728`）`tests/e2e/console.spec.ts`「一覧の検索で0件の表示になる」／`tests/e2e/handoff.spec.ts`「通信断・500: 成功表示をせず再試行でき、応答だけ失っても作成は1回」                                                                                | 一部（詳細の通信断・500・再試行は確認。ホーム・データの空表示、一覧の読込中、入力エラー、キーボード操作は未確認） |
| TC-CONCURRENCY-01 | 同時登録・同時承認・同時 handoff の競合                     | `tests/integration/api.test.ts`「接続プールを超える同時の作成でも詰まらない」／`tests/integration/separation.test.ts`「二重承認は拒否し、拒否の理由も監査に残す（同時・再送の両方）」／`tests/integration/devline-qa-handoff.test.ts`「T-22: 5並列の投入で Issue は1つ」 | 実行済み                                                                                                          |
| TC-RATE-01        | ログイン試行のレート制限（10 回 / 15 分）                   | 一時 API に誤ったパスワードで 11 回（2026-11-09 10:02 JST）。1〜10 回目 401・ERR-106、11 回目 429・ERR-302                                                                                                                                                               | 一部（手順 1〜2 のみ。15 分後の解除と監査ログの確認は未実行）                                                     |

## 5. 未実行・部分・期待との差分

- **TC-AUTH-01**: ログイン成功・失敗・期限切れ・無効化後の失効は確認した。Cookie の `HttpOnly`・`SameSite=Lax` 属性と、ログイン失敗が監査に残ることは、引用したテストでは確認していない（`src/api/auth.ts` の `login_failed` 監査は実装にある）。
- **TC-AUTH-02**: CSRF トークン欠落はテスト済み。Origin 不正の拒否は実装（`src/api/app.ts` の Origin 検査）はあるが、実行証跡は取っていない。
- **TC-AUTHZ-01**: 受付担当の承認は **409 / ERR-201** で拒否される。TC の期待は 403 である。403 は管理 API（`separation.test.ts`）と自己承認（ERR-105）では確認した。**この差は判定せず、品質工作台の判断に委ねる。**
- **TC-REQ-01**: 形式（`REQ-YYYY-0001`）と履歴「受付」は確認した。年が変わったときの 0001 と、複数件での連番の一意性は明示テストが無い（25 並列の作成がすべて 201 になることは確認）。
- **TC-AUDIT-01**: ハッシュ連鎖・管理者限定・CSV 出力は確認した。`audit_log` の UPDATE/DELETE 拒否（`audit_log_no_update` トリガ）と改ざん検知は専用テストが無い。追記専用テーブル 4 種（`order_snapshot` など）の UPDATE/DELETE 拒否は `devline-qa-db.test.ts` の T-04 で確認済み。CSV の 5000 件上限・BOM・secret 非混入は未確認。
- **TC-UI-STATE-01**: CI の e2e で、一覧の検索 0 件表示（`console.spec.ts`）と、依頼詳細の開発ライン操作での通信断・500・再試行・成功表示（`handoff.spec.ts`「通信断・500: 成功表示をせず再試行でき、応答だけ失っても作成は1回」）を確認した。ホーム・データ画面の空表示、一覧の読込中（遅延時の表示と二重操作の禁止）、入力エラー、キーボードだけでの操作は未確認。
- **TC-RATE-01**: 401×10 → 429（ERR-302）を確認した。15 分後の解除（手順 3）と監査記録（手順 4）は未実行。429 に `Retry-After` は付かない。
- **Access 実 JWT・Preview DB・実 SMTP/TLS**: 資格情報が必要なため未実行（C3）。Access の fail-closed は `access-jwt` で確認済み。

## 6. 再現手順

```bash
# 統合テスト（既存の mirai_sf_test を使用。DB の作成・DROP はしない）
pnpm test:integration

# 単体テスト
pnpm test:unit

# ログイン試行のレート制限（NODE_ENV=development の一時 API を空きポートで起動して 11 回試行）
# 実装は src/api/auth.ts の checkLoginRate（IP ごと 15 分 10 回）
```

## 7. 注意

- 本証跡は 2026-11-09 時点のものである。コードが変わった場合は再実行する。
- 生ログはリポジトリ外（`~/.local/state/mirai-sf/evidence/`）にあり、CI・PR の成果物としては残らない。長期の保存が必要なら別途コピーする。
- 本番・Staging の状態は [26-release-status.md](26-release-status.md) を正とする。
