# 要件との対応表（MVP）

正本: 要件定義書 V1.0（MSF-REQ-2026-001）／詳細仕様書 V1.0（MSF-SPC-2026-001）。
「実装」は本リポジトリのMVPで実装済み、「Backlog」はIssue化して対象外、「一部」は制限付き。
状態は 2026-11-09 時点の実装に合わせて更新した。画面の実装はコンソール（`src/web/public/console.js`）と E2E（`tests/e2e/`）を根拠にする。

## 1. 機能要件（7章）

| ID        | 要件                                         | 状態                     | 実装・根拠                                                                   |
| --------- | -------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| FR-01     | 依頼の登録（7ステップ／1枚フォーム）         | 実装（API・画面）        | `POST /api/requests`、SCR-02                                                 |
| FR-02     | カタログから道具を選ぶと件名・部署・色が入る | 実装（API・画面）        | `catalog_tool`、SCR-02/21                                                    |
| FR-03     | 注文書のプレビュー                           | 実装（API・画面）        | `buildOrderYaml`、コンソールのプレビュー                                     |
| FR-04     | 必須チェック・エラー時も入力を消さない       | 実装（API）              | zod、ERR-001                                                                 |
| FR-05     | 合格の条件の書き方チェック                   | 実装                     | `checkCriteria`（26語・仮置き・8文字）                                       |
| FR-06     | よく使う書き方の例文                         | 実装（共有定義）         | `CRITERIA_TEMPLATES`                                                         |
| FR-07     | 添付                                         | **一部**（メタ情報のみ） | `attachment`                                                                 |
| FR-08     | 受付番号の自動採番（二重採番なし）           | 実装                     | `request_counter`、`allocateId`                                              |
| FR-09     | 編集・再提出                                 | 実装（API）              | `PATCH`、差戻し→受付                                                         |
| FR-10     | 信号の色の候補と理由                         | 実装                     | `evaluateSignal`（R1〜R6）                                                   |
| FR-11     | ものさし（削減見込み・5観点）                | 実装                     | `computeMeasure`／`computeScore`                                             |
| FR-12     | 状態管理（12状態）                           | 実装                     | `STATUSES`、遷移表                                                           |
| FR-13     | 役割による操作制限                           | 実装                     | `roleCanTransition`（サーバ判定）                                            |
| FR-14     | 承認者が色を最終決定                         | 実装                     | `POST transitions`（approved）                                               |
| FR-15     | 赤の確認チェック                             | 実装                     | `validateApproval`、ERR-203                                                  |
| FR-16     | 差戻し・見送りの理由必須                     | 実装                     | `isReasonRequired`、ERR-102                                                  |
| FR-17     | コメント・変更履歴                           | 実装                     | `comment`／`request_history`                                                 |
| FR-18     | （FR-52で置換）                              | —                        | FR-52                                                                        |
| FR-19     | ボード                                       | 実装（API・画面）        | `GET /api/requests`、SCR-03                                                  |
| FR-20     | 検索・絞り込み・並べ替え・ページング         | 実装（API・画面）        | `GET /api/requests`（信号の絞り込みは SQL。`09-list-filter-performance.md`） |
| FR-21     | 集計                                         | 一部                     | `catalog/summary`、ホーム件数                                                |
| FR-22     | 印刷                                         | Backlog                  | —                                                                            |
| FR-23     | 注文書YAML                                   | 実装                     | `GET /orders`、`buildOrderYaml`                                              |
| FR-24     | CSV出力（11列・BOM・CRLF）                   | 実装                     | `buildCsv`                                                                   |
| FR-25     | JSON出力・取込（全件置換）                   | 実装                     | `export.json`、`POST /api/import`                                            |
| FR-26     | カタログ（19部署・118件）                    | 実装（API）              | `catalog_tool`                                                               |
| FR-27     | カタログのマスタ管理                         | 一部（seed/DB）          | `department`／`catalog_tool`                                                 |
| FR-28     | 承認済み注文書からIssueを作る                | 実装                     | `POST /api/requests/:id/handoff`（Issue #2 で実測）                          |
| FR-29〜46 | 開発ライン（AI実装・CI・PR・公開・通知）     | Backlog                  | 注文書YAML＋Issueまで                                                        |
| FR-47     | 下書き自動保存・再開                         | 実装（API）              | `draft`、SCR-08                                                              |
| FR-48     | 次へ／元に戻す                               | 一部（APIは遷移）        | SCR-03/05、UIでトースト                                                      |
| FR-49     | 選べる状態だけ表示・理由                     | 実装（API）              | `transitionOptions`                                                          |
| FR-50     | 承認前チェック                               | 実装                     | `preApprovalChecklist`                                                       |
| FR-51     | 差戻し理由テンプレート                       | 実装（共有定義）         | 仕様3-15の文言                                                               |
| FR-52     | ホームの「あなたの番」                       | 実装（API）              | `yourTurn`、`GET /api/home`                                                  |
| FR-53     | 滞留日数（3日/7日）                          | 実装                     | `staleDays`／`staleLevel`                                                    |
| FR-54     | あいまい語の書き換え候補                     | 実装（共有定義）         | `REWRITE_GROUPS`                                                             |
| FR-55     | 標準化・教育                                 | Backlog                  | —                                                                            |
| FR-56     | トレーサビリティ                             | 一部                     | 受付番号・履歴・承認・注文書版                                               |

## 2. 非機能要件（8章）— MVPで担保する範囲

| ID           | 要件                               | 状態     | 根拠                                                 |
| ------------ | ---------------------------------- | -------- | ---------------------------------------------------- |
| NFR-02/03/05 | 権限分離・隔離・なりすまし命令     | 一部     | サーバ側の役割判定。AIは未接続                       |
| NFR-04/10    | 本番データ・個人情報を持ち込まない | 実装     | 作り物データのみ。Backlog/制限に明記                 |
| NFR-06       | 品質ゲート保護                     | 実装     | CI 適用済み（required checks: quality/e2e/docker）   |
| NFR-07       | セキュリティ検査の多層化           | 一部     | 秘密スキャン・CSRF・CSP                              |
| NFR-08       | Entra ID SSO                       | Backlog  | パスワード認証で代替（L-01）                         |
| NFR-09       | 見せる範囲                         | Backlog  | 単一組織・1ユーザー                                  |
| NFR-12/14    | 証跡・保持                         | 一部     | 監査ログ（追記・ハッシュ連鎖）。保持年数は未設定     |
| NFR-16/17    | 圏外・現場操作性                   | Backlog  | 画面実装後                                           |
| NFR-18/19    | やさしさ・アクセシビリティ         | 設計済み | 設計成果物 §4/13。実装後に検証                       |
| NFR-23       | 応答性                             | 決定済み | 目標値 決定済み（`docs/production/07`）              |
| NFR-32       | バックアップ                       | 手順のみ | `docs/deployment.md`                                 |
| NFR-33       | 対応環境                           | 設計済み | PC中心・768pxまで                                    |
| NFR-36       | 環境分離                           | 実装     | 開発DB／テストDB／Preview                            |
| NFR-38       | TLS・MFA                           | 一部     | TLSはCloudflare。MFAはAccess未設定                   |
| NFR-39       | 整合性                             | 実装     | 遷移表・楽観ロック・冪等                             |
| NFR-40       | 品質                               | 一部     | 件数は CI 実行結果を正とする。カバレッジ目標は未測定 |

## 3. データ要件（9章）

| ID                   | 状態 | 備考                           |
| -------------------- | ---- | ------------------------------ |
| DR-01 依頼           | 実装 | `request` 全項目（添付はメタ） |
| DR-02 履歴・コメント | 実装 | 追記型                         |
| DR-03 注文書         | 実装 | YAML・版                       |
| DR-04 カタログ・組織 | 実装 | 19/118                         |
| DR-05 状態・選択肢   | 実装 | 12状態・列挙値                 |
| DR-06 ID・採番       | 実装 | 年別・トランザクション         |
| DR-07 保存・保護     | 一部 | ローカルDB・論理削除           |
| DR-08 入出力         | 実装 | CSV/JSON/YAML                  |

## 4. 完了条件（Goal）との対応

| #     | 完了条件                                  | 状態                                                 |
| ----- | ----------------------------------------- | ---------------------------------------------------- |
| 1     | READMEに目的・利用者                      | 済                                                   |
| 2     | 主要1〜3 FlowをE2Eで実行                  | **画面実装後**（承認待ち）                           |
| 3     | OpenDesignと画面の整合                    | 設計済み・実装後比較                                 |
| 4     | Seed/Dummyで操作                          | 済（見本9件・19/118）                                |
| 5–9   | Normal/Empty/Loading/InputError/CommError | 設計済み・実装後に検証                               |
| 10–11 | Migration/Seed再実行                      | 済（実測）                                           |
| 12    | DB Read/Write                             | 済（integration は CI で実行。件数は CI を正とする） |
| 13–16 | Type/Lint/Test/Build                      | 済（Web buildは承認後）                              |
| 17    | Critical/High既知問題なし                 | 未評価（画面実装後）                                 |
| 18–21 | Preview Deploy/画面/API/DB                | **未（承認後）**                                     |
| 22–29 | ドキュメント                              | 進行中                                               |
| 30–32 | 制限・復旧・Backlog                       | 済／進行中                                           |
