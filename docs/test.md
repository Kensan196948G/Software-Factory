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

| 項目 | 結果 | 備考 |
|---|---|---|
| Typecheck（Web/テスト + API） | **PASS** | エラー0 |
| Lint | **PASS** | 警告0（max-warnings=0） |
| Unit | **43 / 43 PASS** | 信号R1〜R6・条件チェック・ものさし・遷移・権限・承認チェック・YAML/CSV |
| Integration | **24 / 24 PASS** | 実PostgreSQL（`mirai_sf_test`）。認証/CSRF/採番/冪等/承認/差戻し/取消/版競合/出力/監査 |
| E2E（開発ビルド） | **6 / 6 PASS** | コンソール原本UI: ログイン、登録→再読込でDBから復元、役割切替、承認、0件検索、ログイン失敗 |
| E2E（本番ビルド＋Preview DB） | **6 / 6 PASS** | `node dist/api/server.js` + `mirai_sf`（production想定） |
| Build | **PASS** | `dist/api` と `dist/web` |
| DB verify | **PASS** | 19部署／118道具（青52/黄47/赤19）／採番／監査ハッシュ連鎖 |
| Secret scan | **PASS** | 追跡75ファイル |
| GitHub Issue 自動作成 | **PASS** | 受付 `REQ-2026-0009` から Issue #2 を作成（実測） |
| Cloudflare Preview | **PASS（Access保護）** | `https://sf.mirai-dx-platform.com` は Access のサインインへ302。origin の `/healthz` は tunnel 経由で200 |
| CI（GitHub Actions） | **未実行（Blocker）** | `.github/workflows/` がポリシーゲートで拒否。`docs/patches/ci.workflow.yml` を人間が適用する |

## 3. テスト構成

| ファイル | 内容 |
|---|---|
| `tests/unit/domain.test.ts` | 信号の色（R1〜R6、赤はR1/R2のみ）、合格の条件（26語・仮置き・短い・OK）、書き換え候補、ものさし、5観点、遷移表、役割権限、理由必須、承認前チェック、承認検証、あなたの番、滞留 |
| `tests/unit/output.test.ts` | 注文書YAML（項目・引用・改行・空リスト・日本語ラベル・日付）、CSV（BOM/CRLF/引用/11列）、JSON |
| `tests/integration/api.test.ts` | ログイン・401/403・CSRF、採番、信号候補、冪等キー、入力検証、承認（受付担当は不可・承認者のみ）、注文書生成、ゆるい色の理由、差戻し→再提出、取消、版競合、不正遷移、カタログ、ホーム、CSV/JSON、監査連鎖、セッション期限 |
| `tests/e2e/console.spec.ts` | コンソール原本UI: ログイン、登録→DB永続、役割切替、承認（承認者のみ）、0件検索、ログイン失敗 |

## 4. E2E のシナリオ

1. ログインしてコンソールが表示される
2. ログイン失敗はエラーを表示する
3. 依頼を登録し、再読み込みしてもDBから残る
4. 役割切替がAPIのセッションに反映される
5. 承認できる（承認者のみ）
6. 一覧の検索で0件の表示になる

## 5. 未実施・残り

- Cloudflare Access の**ワンタイムパスワードでの実ログイン**は、受信メールが必要なため自動化していない。Access のリダイレクトとポリシーは実測済み。人間の最終確認が必要（`docs/deployment.md` §4）。
- CI は未適用（上記 Blocker）。ローカルで同一手順を実行し、結果を本表に記録した。
