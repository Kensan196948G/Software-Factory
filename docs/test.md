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
| E2E（開発ビルド） | **9 / 9 PASS** | 登録・承認・完了の3フロー、入力エラー、空状態、Esc、通信エラー、カタログ、権限 |
| E2E（本番ビルド＋Preview DB） | **9 / 9 PASS** | `node dist/api/server.js` + `mirai_sf`（production想定） |
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
| `tests/e2e/flows.spec.ts` | 3フロー、入力エラー、空状態、Esc、通信エラー、カタログ、権限（受付担当は承認不可） |

## 4. E2E のシナリオ

1. 依頼を登録できる（7ステップ → 受付番号 → 詳細）
2. 受付担当が進め、承認者が承認して注文書YAMLが出る
3. 現場試用から完了まで進められる（完了は承認者のみ）
4. 件名が空だと次へ進めない（入力エラー）
5. 条件に合う依頼がない（空状態）
6. Escで詳細ドロワーを閉じられる（キーボード）
7. API停止時にエラー表示になる（通信エラー）
8. カタログに19部署・118件が出る
9. 受付担当では「承認済み」を選べない（権限）

## 5. 未実施・残り

- Cloudflare Access の**ワンタイムパスワードでの実ログイン**は、受信メールが必要なため自動化していない。Access のリダイレクトとポリシーは実測済み。人間の最終確認が必要（`docs/deployment.md` §4）。
- CI は未適用（上記 Blocker）。ローカルで同一手順を実行し、結果を本表に記録した。
