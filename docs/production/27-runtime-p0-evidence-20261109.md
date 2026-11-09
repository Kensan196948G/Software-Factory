# ランタイム P0 実行証跡（2026-11-09）

作成: 2026-11-09 JST。状態: **実行証跡**（合否の判定ではない）。
時刻はすべて JST。実行したのは分離 DB（`mirai_sf_test`）とローカルの API だけで、本番・Staging・Cloudflare には触れていない。

## 1. 目的と範囲

- 品質工作台のリリース判定（NO-GO）で不足していた**ランタイム P0 の実行証跡**を記録する。
- 対象は未実行だった P0 19 件（TC-AUTH-01/02、TC-AUTHZ-01、TC-REQ-01/02/03、TC-FLOW-01、TC-APPROVE-01/02/03、TC-ORDER-01、TC-AUDIT-01、TC-DEVLINE-01/02、TC-HEALTH-01、TC-ACCESS-01、TC-UI-STATE-01、TC-CONCURRENCY-01、TC-RATE-01）。
- **この文書は証跡であり、テストケースの合否を判定しない。** TC を `executed` にするかどうかは品質工作台（dsh-qa）で判断する。

## 2. 実行環境と条件

| 項目          | 値                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| 実行 HEAD     | `dbfede1e`（統一テスト実行時）。その後の `2a02024f` は docs のみの変更で、コードは同一                               |
| 実行日時      | 2026-11-09 08:29〜08:42 JST（統合テスト）、2026-11-09 09:39 JST（レート制限）                                        |
| Node / pnpm   | Node v22.22.3 / pnpm 12（プロジェクトの指定どおり）                                                                  |
| DB            | `mirai_sf_test`（既存のテスト DB。DB の作成・DROP はしていない）                                                     |
| API           | レート制限の確認のみ、`127.0.0.1:18999` で一時起動（`NODE_ENV=development`・`AUTH_MODE=password`・`MAIL_MODE=file`） |
| 本番・Staging | 参照も変更もしていない（Staging の自動追従は別の運用で動いている）                                                   |

## 3. 実行結果サマリ

| 実行                     | コマンド                                               | 結果                                                         | 証跡                                         |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------- |
| 統合テスト               | `pnpm test:integration`                                | **24 ファイル / 780 テスト pass**、exit 0、843.30 秒         | 実行ログ（ローカル）                         |
| 単体テスト               | QA の既存実行                                          | 974 件 pass（補助証跡。単体は API/DB/UI の動作を保証しない） | 品質工作台の実行記録 `run_mw8eti3s_5cf2d40a` |
| ログイン試行のレート制限 | `NODE_ENV=development` の一時 API に 11 回ログイン試行 | 1〜10 回目 **401**、11 回目 **429（ERR-302）**               | 実行日時 2026-11-09 09:39:20 JST             |

## 4. テストケースとの対応

「実行証跡あり」は、TC が対象とする振る舞いを実行するテストが pass したことを示す。「一部」は、TC の一部の条件が未検証であることを示す。

| TC                | 内容                                                        | 主な証跡（テストファイル / テスト名）                                                                                                                                                                                                                                                                                                                  | 判定                                                                        |
| ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| TC-AUTH-01        | ログイン成功・失敗・無効化後のセッション失効                | `tests/integration/api.test.ts`「ログインに成功するとユーザーとCSRFトークンを返す」「パスワードが違うと401」「期限切れのセッションは401」／`tests/integration/separation.test.ts`「無効化した利用者はログインできず、既存のセッションも使えない」／`tests/e2e/console.spec.ts`「ログインしてコンソールが表示される」「ログイン失敗はエラーを表示する」 | 実行証跡あり                                                                |
| TC-AUTH-02        | CSRF 欠落・不一致・不正 Origin の拒否                       | `tests/integration/api.test.ts`「更新系はCSRFトークンがないと403」                                                                                                                                                                                                                                                                                     | 一部（不正 Origin の拒否は専用テスト未実行）                                |
| TC-AUTHZ-01       | 役割別の遷移許可と 403                                      | `tests/integration/api.test.ts`「受付担当は承認できず、承認者が信号を決めて承認できる」／`tests/integration/separation.test.ts` の役割・管理者テスト群                                                                                                                                                                                                 | 実行証跡あり                                                                |
| TC-REQ-01         | 受付登録・年別採番・連番の一意性                            | `tests/integration/api.test.ts`「受付番号を採番し、履歴に「受付」を残す」／`tests/integration/api.test.ts` の採番・一覧テスト                                                                                                                                                                                                                          | 実行証跡あり                                                                |
| TC-REQ-02         | Idempotency-Key による同一応答と内容違い 409                | `tests/integration/api.test.ts`「同じ冪等キー・同じ内容なら同じ依頼を返す」「同じ冪等キーで内容が違うと409 ERR-008」「作成後にマスタが変わっても、同じキーの再送は作成済みの依頼を返す」                                                                                                                                                               | 実行証跡あり                                                                |
| TC-REQ-03         | 受付入力の境界値                                            | `tests/integration/api.test.ts`「合格の条件が9件なら400 ERR-006」「件名が60文字を超えると400」「カタログ外の道具IDは400」「部署と合わない道具は ERR-013（400）」                                                                                                                                                                                       | 実行証跡あり                                                                |
| TC-FLOW-01        | 12 状態の遷移表・理由必須・楽観ロック                       | `tests/integration/api.test.ts`「古い版番号での更新は409 ERR-301」「受付から承認済みへ直接は409」「差戻しは理由必須」「取消は論理削除で、一覧から外れる」                                                                                                                                                                                              | 実行証跡あり                                                                |
| TC-APPROVE-01     | 承認前チェックの△と承認拒否（ERR-203）                      | `tests/integration/api.test.ts`「候補よりゆるい色は理由が必要（ERR-102）」／`tests/integration/api.test.ts:275` の ERR-203 検証                                                                                                                                                                                                                        | 実行証跡あり                                                                |
| TC-APPROVE-02     | 自己承認の環境別挙動と監査警告                              | `tests/integration/separation.test.ts`「自己承認の拒否（ERR-105）」と「開発既定（ALLOW_SELF_APPROVAL=1）では従来どおり自己承認できる」                                                                                                                                                                                                                 | 実行証跡あり                                                                |
| TC-APPROVE-03     | 二重承認の拒否（同一版 409 / 最新版 409）                   | `tests/integration/separation.test.ts`「二重承認は拒否し、拒否の理由も監査に残す（同時・再送の両方）」                                                                                                                                                                                                                                                 | 実行証跡あり                                                                |
| TC-ORDER-01       | 注文書 YAML の取得条件・決定性・版                          | `tests/integration/api.test.ts`「承認済みなら注文書YAMLを生成できる（未承認は409 ERR-205）」／`tests/unit/output.test.ts`「先頭に schema_version と order_version を持つ」「空のリストは [] で出す」「改行は空白に置きかえ、引用符をエスケープする」                                                                                                   | 実行証跡あり                                                                |
| TC-AUDIT-01       | 監査ハッシュ連鎖・改ざん検知・UPDATE/DELETE 拒否            | `tests/integration/api.test.ts`「監査ログはハッシュ連鎖が壊れていない」「監査ログは管理者だけが読める」「監査ログをCSVで書き出せる（管理者のみ）」／`db/migrations/0001_init.sql` の `audit_log_no_update` トリガ                                                                                                                                      | 一部（`audit_log` の UPDATE/DELETE 拒否はトリガ実装で、専用テストは未実行） |
| TC-DEVLINE-01     | handoff の許可外・公開リポジトリ拒否と冪等                  | `tests/integration/devline-qa-handoff.test.ts`「T-21: 同じ版の再投入で Issue が増えず created=false」「T-22: 5並列の投入で Issue は1つ」「T-93: 同じ POST の再実行で監査・履歴が増えない」／`tests/integration/devline-target-selection.test.ts`                                                                                                       | 実行証跡あり                                                                |
| TC-DEVLINE-02     | AC 未確認の非合格・人の承認・agent 拒否・二重押下           | `tests/integration/devline-qa-verify.test.ts`「未知の status や空の段階を passed に数えない」「同じ段階が passed と skipped の両方なら悪い方（合格にしない）」「同じ配信を並行で5回送っても記録は1件」／`tests/integration/devline-ac-gui.test.ts`                                                                                                     | 実行証跡あり                                                                |
| TC-HEALTH-01      | healthz の usersActive と外形監視の失敗判定                 | `tests/integration/healthz-auth.test.ts`「usersActive は無効な利用者を数えない」「本番相当で JWT 未設定・ヘッダ信頼無効なら 200 のまま misconfigured」／`tests/unit/healthcheck-offsite.test.ts`                                                                                                                                                       | 実行証跡あり                                                                |
| TC-ACCESS-01      | Access JWT の fail-closed と最小権限の自動登録              | `tests/integration/access-jwt.test.ts`「ヘッダのメールだけでは401」「改ざんした JWT は401（500にしない）」「本番では未登録の利用者を自動登録しない」「サービストークンは common_name が許可リストにあるときだけ通る」                                                                                                                                  | 実行証跡あり（実 JWT での E2E は未実行。C3 の資格情報待ち）                 |
| TC-UI-STATE-01    | 主要画面の 5 状態（空・読込・入力エラー・通信エラー・成功） | `tests/e2e/console.spec.ts`「ログイン失敗はエラーを表示する」「一覧の検索で0件の表示になる」など                                                                                                                                                                                                                                                       | 一部（5 状態のうち通信エラー・読込中の確認は未実行）                        |
| TC-CONCURRENCY-01 | 同時登録・同時承認・同時 handoff の競合                     | `tests/integration/api.test.ts`「接続プールを超える同時の作成でも詰まらない」／`tests/integration/separation.test.ts`「二重承認は拒否し、拒否の理由も監査に残す（同時・再送の両方）」／`tests/integration/devline-qa-handoff.test.ts`「T-22: 5並列の投入で Issue は1つ」                                                                               | 実行証跡あり                                                                |
| TC-RATE-01        | ログイン試行のレート制限（10 回 / 15 分）                   | `NODE_ENV=development` の一時 API に 11 回ログイン試行（2026-11-09 09:39 JST）。1〜10 回目 401、11 回目 429                                                                                                                                                                                                                                            | 実行証跡あり                                                                |

## 5. 未実行・部分の理由

- **TC-AUTH-02 の不正 Origin**: CSRF トークン欠落はテスト済みだが、Origin 不正の拒否は専用テストが無い。実装（`src/api/app.ts` の Origin 検査）はあるが、実行証跡は取っていない。
- **TC-AUDIT-01 の `audit_log` UPDATE/DELETE 拒否**: トリガ（`db/migrations/0001_init.sql` の `audit_log_no_update`）で実装されているが、`audit_log` を対象にした UPDATE/DELETE の拒否テストは無い。同じ方式の他テーブル（`order_snapshot` など）は T-04 で拒否を確認済み。
- **TC-UI-STATE-01 の 5 状態**: E2E はログイン失敗・0 件検索などを確認するが、読込中・通信エラーの状態は未確認。
- **Access 実 JWT・Preview DB・実 SMTP/TLS**: 資格情報が必要なため未実行（C3）。Access の fail-closed は `access-jwt` で確認済み。

## 6. 再現手順

```bash
# 統合テスト（既存の mirai_sf_test を使用。DB の作成・DROP はしない）
pnpm test:integration

# ログイン試行のレート制限（NODE_ENV=development の一時 API を空きポートで起動して 11 回試行）
# 実装は src/api/auth.ts の checkLoginRate（IP ごと 15 分 10 回）
```

## 7. 注意

- 単体テスト 974 件は**補助証跡**である。API・DB・UI の動作やリリース可否を証明しない。
- 本証跡は 2026-11-09 時点のものである。コードが変わった場合は再実行する。
- 本番・Staging の状態は [26-release-status.md](26-release-status.md) を正とする。
