# テスト

## 1. 実行方法

```bash
pnpm typecheck      # 型チェック（Web/テスト + API）
pnpm lint           # ESLint（--max-warnings=0）
pnpm test           # unit（43）+ integration（24）
pnpm test:e2e       # Playwright（9シナリオ）
pnpm build          # API + Web
pnpm db:verify      # DB整合性（19/118/採番/監査連鎖）
node scripts/secret-scan.mjs
BASE_URL=... SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm exec tsx scripts/smoke.ts
```

## 2. 実測結果（2026-10-28）

| 項目                           | 結果                                                                        | 備考                                                                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck（Web/テスト + API）  | **PASS**                                                                    | エラー0                                                                                                                                                                                                        |
| Lint                           | **PASS**                                                                    | 警告0（max-warnings=0）                                                                                                                                                                                        |
| Unit                           | **59 / 59 PASS**                                                            | 信号R1〜R6・条件チェック・ものさし・遷移・権限・承認チェック・YAML/CSV・承認依頼メール（本文/MIME/宛先/ヘッダ注入/送信経路/EPIPE）                                                                             |
| Integration                    | **43 / 43 PASS**                                                            | 実PostgreSQL（`mirai_sf_test`）。認証/CSRF/採番/冪等/承認/差戻し/取消/版競合/出力/監査/下書きのサーバ保存/運用状態のDB保存/承認依頼メール（送信キュー・失敗分離・再送の拒否）                                  |
| E2E（開発ビルド）              | **10 / 10 PASS**（+1 skip: Access 越しスモークは認証情報未設定のため skip） | コンソール原本UI: ログイン、登録→再読込でDBから復元、役割切替、承認、0件検索、ログイン失敗、下書きの別端末再開、運用データのDB復元                                                                             |
| E2E（本番ビルド）              | **10 / 10 PASS**                                                            | `dist` 起動（dev DB・`AUTH_MODE=password`・`COOKIE_SECURE=0` の検証用設定）                                                                                                                                    |
| SMTP（ローカル受け皿）         | **到達 1通**                                                                | 実アプリを `MAIL_MODE=smtp`（AUTH PLAIN 付きの受け皿）で起動し、承認依頼が `status='sent'`・`.eml` 1通を実測。TLS は未実測（テスト用証明書の生成が承認されず）                                                 |
| 監査アーカイブ                 | **PASS**                                                                    | `pnpm audit:archive` で 621件を `audit-2026-10-28.jsonl.gz` へ差分出力（ハッシュ連鎖 621件 OK）                                                                                                                |
| E2E（Cloudflare Access 越し）  | **未実行（Blocker）**                                                       | サービストークン作成に Cloudflare API の `access-service-token.write` 権限が必要（現行トークンでは403）。スモークは `tests/e2e/access.spec.ts` に実装済みで、`E2E_ACCESS_URL` と資格情報を設定すれば実行できる |
| E2E（Preview DB / `mirai_sf`） | **未実行（Blocker）**                                                       | `preview.conf` の `SEED_ADMIN_PASSWORD` が空でログインできない。migration は適用済み。Preview 自体は再ビルド・再起動済み（`/console.js` 新版・公開URLは Access 302）                                           |
| Build                          | **PASS**                                                                    | `dist/api` と `dist/web`                                                                                                                                                                                       |
| DB verify                      | **PASS**                                                                    | 19部署／118道具（青52/黄47/赤19）／採番／監査ハッシュ連鎖                                                                                                                                                      |
| Secret scan                    | **PASS**                                                                    | 追跡96ファイル                                                                                                                                                                                                 |
| GitHub Issue 自動作成          | **PASS**                                                                    | 受付 `REQ-2026-0009` から Issue #2 を作成（実測）                                                                                                                                                              |
| Cloudflare Preview             | **PASS（Access保護）**                                                      | `https://sf.mirai-dx-platform.com` は Access のサインインへ302。origin の `/healthz` は tunnel 経由で200                                                                                                       |
| CI（GitHub Actions）           | **quality + e2e**                                                           | `quality`（typecheck/lint/unit/migration/seed/db:verify/integration/build/secret scan）と `e2e`（Postgres＋ビルド＋Playwright）をPRのたびに実行                                                                |

## 3. テスト構成

| ファイル                         | 内容                                                                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/domain.test.ts`      | 信号の色（R1〜R6、赤はR1/R2のみ）、合格の条件（26語・仮置き・短い・OK）、書き換え候補、ものさし、5観点、遷移表、役割権限、理由必須、承認前チェック、承認検証、あなたの番、滞留                                                    |
| `tests/unit/output.test.ts`      | 注文書YAML（項目・引用・改行・空リスト・日本語ラベル・日付）、CSV（BOM/CRLF/引用/11列）、JSON                                                                                                                                     |
| `tests/unit/mailer.test.ts`      | 承認依頼メール: 本文・滞留通知の項目、宛先の検証（ヘッダ注入の拒否）、RFC 2047、MIME、file/off/sendmail/smtp の送信経路（SMTPは擬似サーバ）、EPIPE、設定要約                                                                      |
| `tests/integration/api.test.ts`  | ログイン・401/403・CSRF、採番、信号候補、冪等キー、入力検証、承認、注文書生成、差戻し→再提出、取消、版競合、不正遷移、カタログ、ホーム、CSV/JSON、監査連鎖、監査CSV、セッション期限、下書きの複数件、運用状態のDB保存と楽観ロック |
| `tests/integration/mail.test.ts` | 承認待ちで1通積まれる／送信済みになる、承認者のメール優先（`approver_user_id`）、承認者が別人なら承認できない、送信BOXと件数のAPI、送信失敗でも遷移は成功・再送できる、滞留通知は1日1回、`MAIL_MODE=off` は積まない               |
| `tests/e2e/console.spec.ts`      | コンソール原本UI: ログイン、登録→DB永続、役割切替、承認（承認者のみ）、監査ログとCSV、承認依頼メールの表示と送信BOX、0件検索、ログイン失敗、下書きの別端末再開、運用データのDB復元                                                |

## 4. E2E のシナリオ

1. ログインしてコンソールが表示される
2. ログイン失敗はエラーを表示する
3. 依頼を登録し、再読み込みしてもDBから残る
4. 役割切替がAPIのセッションに反映される
5. 承認できる（承認者のみ）
6. 一覧の検索で0件の表示になる
7. 下書きがサーバに保存され、別端末（別コンテキスト）で再開できる
8. 運用データがDBに保存され、再読み込みで復元される

（7・8 の前に、`login()` がサーバの下書きを消して毎回まっさらから始める。端末をまたぐ下書きが別テストへ漏れないようにするため。）

## 5. 未実施・残り

- Cloudflare Access の**ワンタイムパスワードでの実ログイン**は、受信メールが必要なため自動化していない。Access のリダイレクトとポリシーは実測済み。人間の最終確認が必要（`docs/deployment.md` §4）。
- E2E（Preview DB `mirai_sf`）は、`preview.conf` の `SEED_ADMIN_PASSWORD` が空のため未実行（migration は適用済み）。
- SMTP はローカル受け皿で認証付きの到達を実測済み。実プロバイダ・TLS（STARTTLS/暗黙TLS）は未検証（認証情報と証明書が必要）。
- 滞留通知・下書きTTL・（別コマンドで）監査アーカイブは、systemd user timer `mirai-sf-reminders.timer`（毎日 08:30）で実行する（登録済み・初回実行で催促1通を実測）。
