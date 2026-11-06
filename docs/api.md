# API

正本: 詳細仕様書 V1.0 6-7（API-01〜08）。実装: `src/api/app.ts` / `src/api/service.ts`。

## 1. 共通

- 認証: `msf_session` Cookie（HttpOnly / SameSite=Lax / Secure は本番）。セッションはDB。
- `AUTH_MODE=access`: `ACCESS_TEAM_DOMAIN` と `ACCESS_AUD` を設定すると、毎回 `Cf-Access-Jwt-Assertion` の JWT を検証する（`docs/deployment.md` §3-1）。未設定の場合は **fail-closed** で、`Cf-Access-Authenticated-User-Email` / `Cf-Access-Client-Id` ヘッダを信頼しない（401）。このとき `ACCESS_TRUST_EMAIL_HEADER=1` を明示するとヘッダ信頼を opt-in できるが、許可されるのは **`APP_ENV` を明示した** development / test だけ。`APP_ENV=staging` / `production`、または `ACCESS_TRUST_EMAIL_HEADER=1` かつ `APP_ENV` 未設定のときは**起動エラー**になる（Issue #102。2026-11-06）。
- `AUTH_MODE=access` で利用者表に無いメールは、既定では自動作成せず 401 にする（`auth.access_denied` / reason=`user_not_registered` を監査）。開発・テストで自動作成が必要なときだけ `ACCESS_AUTO_PROVISION=1` を明示する（既定 `0`。`0` / `1` 以外、`APP_ENV=staging` / `production`、`NODE_ENV=production` では起動エラー）。有効時も作るのは最小権限（`is_admin=false`・`requester` のみ）で、`user.provisioned`（isAdmin=false, roles=['requester']）を監査に残す。利用者の作成は管理API（§6）が原則（Issue #102 完了条件 3。2026-11-06）。
- CSRF: 更新系は `X-CSRF-Token` ヘッダが必要（`msf_csrf` Cookie と一致）。`Origin` も検証。
- 役割: サーバ側で毎回判定。クライアントの「いまの役割」は信用しない。
- エラー: `{ "error": { "code": "ERR-xxx", "message": "...", "details"?, "correlationId"? } }`
- 相関ID: レスポンスヘッダ `X-Correlation-Id`。監査ログに記録。
- 楽観ロック: 更新系は `version` を要求。不一致は 409 `ERR-301`。
- 環境名: `GET /healthz` と `GET /api/meta` の `environment` は `APP_ENV`（`development` / `test` / `staging` / `production`）の値。未指定・空なら `NODE_ENV` と同じ。不正な値は起動エラー。表示専用で、Cookie の Secure などセキュリティ挙動は `NODE_ENV` で決まる。
- 冪等: `POST /api/requests` は `Idempotency-Key` ヘッダ。同じキー・同じ内容なら同じ依頼を返す。内容が違えば 409 `ERR-008`。

## 2. エンドポイント

| #      | メソッド / パス                                      | 説明                                                                                                         | 権限                                                |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| —      | `GET /healthz`                                       | 稼働確認（DBレイテンシ・version・commit）                                                                    | なし                                                |
| —      | `GET /readyz`                                        | 受付可能か（DB必須、503あり）                                                                                | なし                                                |
| —      | `POST /api/auth/login`                               | ログイン                                                                                                     | なし（レート制限）                                  |
| —      | `POST /api/auth/logout`                              | ログアウト                                                                                                   | 要ログイン                                          |
| —      | `GET /api/auth/me`                                   | 現在の利用者と役割                                                                                           | 要ログイン                                          |
| —      | `POST /api/auth/role`                                | 検証用の役割切替                                                                                             | 要ログイン・付与済み役割のみ                        |
| —      | `GET /api/meta`                                      | アプリ情報・しきい値・承認者一覧（ログイン時は利用者表の承認者マスタ。本番以外は見本名も併記、未ログインは実在のメールを出さない） | なし                                                |
| —      | `GET /api/approvers`                                 | 承認者マスタ（有効な approver ロールの利用者: `id` / `displayName` / `email` / `deptCode`）                  | 要ログイン                                          |
| API-01 | `POST /api/requests`                                 | 依頼の作成（採番・履歴・冪等）。任意で `approverUserId` を指定でき、無ければ承認者欄の名前・メールから解決   | 要ログイン                                          |
| API-02 | `GET /api/requests/{id}`                             | 依頼の詳細（履歴・コメント・候補・遷移）                                                                     | 要ログイン                                          |
| API-02 | `PATCH /api/requests/{id}`                           | 依頼の更新（版番号必須）                                                                                     | 依頼者（受付/差戻しの自分の依頼）・受付担当・承認者 |
| API-03 | `POST /api/requests/{id}/transitions`                | 状態変更（遷移表・権限・理由）                                                                               | 遷移表のとおり                                      |
| API-04 | （同上で `to=approved`）                             | 信号の色の決定・承認前チェック                                                                               | 承認者のみ                                          |
| API-05 | `GET /api/requests/{id}/order`                       | 注文書YAML（承認済みのみ）                                                                                   | 要ログイン                                          |
| —      | `POST /api/requests/{id}/comments`                   | コメント追加                                                                                                 | 要ログイン                                          |
| —      | `GET /api/home`                                      | あなたの番・件数・滞留                                                                                       | 要ログイン                                          |
| —      | `GET /api/requests`                                  | 一覧（`q` `dept` `status` `signal` `mine` `includeDeleted` `page` `pageSize`）                               | 要ログイン                                          |
| —      | `GET /api/drafts` / `POST /api/drafts`               | 下書きの一覧（新しい順・最大50）／作成                                                                       | 要ログイン（本人のみ）                              |
| —      | `PUT /api/drafts/{id}` / `DELETE /api/drafts/{id}`   | 下書きの更新／削除（他人の下書きは404）。保存期限 `DRAFT_TTL_DAYS`（既定30日）を過ぎたものは日次ジョブが消す | 要ログイン（本人のみ）                              |
| —      | `DELETE /api/drafts`                                 | 本人の下書きをすべて削除                                                                                     | 要ログイン                                          |
| —      | `GET /api/catalog/departments` / `tools` / `summary` | カタログ                                                                                                     | 要ログイン                                          |
| —      | `GET /api/export.json` / `export.csv`                | 全件出力（監査ログに記録）                                                                                   | 要ログイン                                          |
| —      | `POST /api/import`                                   | JSON取込（全件置換・検証付き）                                                                               | 承認者/管理者・`ALLOW_IMPORT=1`                     |
| —      | `GET /api/admin/users`                               | 利用者の一覧（無効・ロールを含む。パスワードは返さない）                                                     | 管理者                                              |
| —      | `POST /api/admin/users`                              | 利用者の作成（`email` `displayName` `deptCode` `password` `roles` `isAdmin`）。パスワードは scrypt            | 管理者                                              |
| —      | `PATCH /api/admin/users/{id}`                        | ロール付与（`roles`）・パスワード変更（`password`）・無効化/有効化（`isActive`）                             | 管理者                                              |
| API-08 | `GET /api/audit-logs`                                | 監査ログ（ハッシュ連鎖の検証結果つき）                                                                       | 管理者                                              |
| —      | `GET /api/audit-logs.csv`                            | 監査ログのCSV（最大5000件・BOM付き）                                                                         | 管理者                                              |
| —      | `GET /api/ops` / `PUT /api/ops`                      | 運用・DevOps・SecOps の画面状態（id=1 の単一ドキュメント）。PUT は `version` 必須で、古い版は409             | GET: 要ログイン / PUT: 受付担当・承認者・管理者     |
| —      | `GET /api/mail/status`                               | 承認依頼メールの設定と件数（Secrets・サーバ内パスは含めない）                                                | 要ログイン                                          |
| —      | `GET /api/mail/outbox`                               | 送信BOX（`status=pending \| sending \| sent \| failed`、`limit`）                                            | 受付担当・承認者・管理者                            |
| —      | `POST /api/mail/outbox/{id}/retry`                   | 送信に失敗した1通を再送（送信済み・不正IDは404）                                                             | 受付担当・管理者                                    |
| —      | `POST /api/mail/flush`                               | 未送信ぶんをまとめて送る（最大20件。10分以上stuckした送信中も拾う）                                          | 管理者                                              |
| —      | `POST /api/mail/reminders`                           | 滞留通知を積む（`days` 既定3・同じ依頼は1日1回）。日次ジョブ `pnpm reminders` と同じ処理                     | 管理者                                              |
| —      | `POST /api/admin/reset-demo`                         | 見本データへ戻す（開発のみ）                                                                                 | 管理者・非production                                |

## 3. 状態遷移の可否（要点）

- 受付 → 内容確認中（受付担当）
- 内容確認中 → 承認待ち（受付担当。合格の条件1件以上）
- 承認待ち → 承認済み（**承認者のみ**。信号の決定・△チェック・赤の確認・ゆるい色の理由）
- 承認済み → 実装中 → 検証中 → 現場試用 → 公開承認待ち → 完了（完了は承認者のみ）
- 差戻し（理由必須）→ 受付（依頼者が再提出）
- 見送り・取消（理由必須、取消は論理削除）

拒否時は 409 `ERR-201`（理由と「できる人」を含む）。不正な遷移も監査ログに残す。

承認（`to=approved`）で、依頼の作成者（`request.applicant_user_id`）と承認した人が同じときは 403 `ERR-105`。
`APP_ENV=production` では `ALLOW_SELF_APPROVAL` の既定が 0（拒否）で、開発・テスト・staging の既定は 1（従来動作）。
本番で明示 1 にした場合は許可するが、起動時と自己承認のたびに監査へ警告（`config.self_approval_enabled` / `approval.self_allowed`）を残す。
拒否は `approval.self_denied`、二重承認は `approval.duplicate_denied` / `request.transition_denied` として監査に残す。

## 4. 注文書YAML

`GET /api/requests/{id}/order` は `text` としてYAMLを返す（`yaml` フィールド）。
`schema_version` / `order_version` を持ち、`signal.suggested` と `signal.decided` を分ける。`data_handling` は日本語ラベル。

## 5. 承認依頼メール（送信キュー）

依頼が「承認待ち」になったとき、承認者へメールを1通送る（IF-02/FR-44 の最小実装）。

- 積む: 状態遷移（と「承認後に内容を編集して承認待ちへ戻す」更新）と同じトランザクションで `mail_outbox` に1行。メールが消えない。
- 送る: コミット後に best-effort。送信前に `status='sending'` へ原子的に移す（claim）ので二重送信しない。
  失敗しても遷移は成功し、`status='failed'` と `last_error` が残る（応答の `warnings` に `INFO-002`）。
  `POST /api/mail/outbox/{id}/retry` は**手動再送**（バックオフを待たない）。自動再送は `next_attempt_at` と `MAIL_RETRY_MAX`/`MAIL_RETRY_BASE_MINUTES`（指数バックオフ）で、日次ジョブと `flush` が期日を過ぎた行を拾う。10分以上 `sending` のままの行も拾い直す。
- 宛先: ①承認者のメール（`request.approver_user_id`。作成・更新の `approverUserId`、または承認者欄の名前・メールから利用者表で解決）→
  ②`request.approver` がメール形式ならそれ → ③同じ表示名の利用者のメール → ④`MAIL_APPROVAL_TO`。どれも無ければ積まない。
- 送信経路（`MAIL_MODE`）: `off`（送らない・本番の既定）/ `file`（`.mail/outbox` へ `.eml` を書き出す・開発とテストの既定）/ `sendmail`（ローカルMTAへ `sendmail -t -i`）/ `smtp`（`SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_REQUIRE_TLS` `SMTP_USER` `SMTP_PASS`。認証情報は local.json（0600）か環境変数だけに置く）。
- 滞留通知: `kind='reminder'`。`status in ('wait','release_wait')` で `updated_at` が N 日以上前の依頼へ、1日1回だけ積む（`(request_id, kind, reminder_date)` の unique）。
- Secrets は持たない（SMTP のホスト・認証は未実装。`docs/limitations.md` L-04）。
- 監査: `mail.enqueue` / `mail.sent` / `mail.failed` を監査ログに残す（送信結果の更新と同じトランザクション）。

## 6. 職務分離（複数ユーザー・承認者マスタ）

- 利用者は管理API（`/api/admin/users`）で作る。パスワードは scrypt（`src/api/password.ts`）で、10文字以上200文字以下・メールアドレスと同じものは不可。作成・ロール付与・パスワード変更・無効化は監査ログに actor と結果（success / denied）を残す。パスワードの値・ハッシュは監査に残さない。
- ロールはサーバの3役（`requester` / `desk` / `approver`）。画面の運用・セキュリティ・管理・監査は従来どおり `approver` に割り当てる。
- 無効化するとログインできず、その利用者のセッションも失効する。最後の管理者と自分自身は無効化できない。
- 承認者マスタは `app_user` の `approver` ロール（有効な人）から解決する。`GET /api/approvers` が一覧、依頼の `approverUserId` はユーザーIDを優先する。名前一致は後方互換で許容（見本データなど）。
- 自己承認（依頼の作成者と承認者が同じユーザーID）は本番の既定で拒否（`ERR-105`）。開発の既定は従来どおり許可する。
- 二重承認は拒否する。同じ版の再送は 409 `ERR-301`、最新版で「もう承認済み」は 409 `ERR-201`。

## 7. 例

```bash
curl -c c.txt -X POST http://127.0.0.1:8781/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"...","password":"..."}'

curl -b c.txt http://127.0.0.1:8781/api/home

curl -b c.txt -X POST http://127.0.0.1:8781/api/requests/REQ-2026-0003/transitions \
  -H 'content-type: application/json' -H 'x-csrf-token: <csrf>' \
  -d '{"to":"approved","version":3,"signal":"y","checklistAcknowledged":true}'
```

`csrf` はログイン応答の `csrf`、または `GET /api/auth/me` 後に `document.cookie` の `msf_csrf` から取得する。
