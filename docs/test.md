# テスト

## 1. 実行方法

```bash
pnpm typecheck      # tsc（Web/テスト + API）
pnpm lint           # ESLint（--max-warnings=0）
pnpm test           # unit（43）+ integration（24）
pnpm test:e2e       # Playwright（WebUI実装後に有効）
pnpm build          # API + Web
pnpm db:verify      # DB整合性（19/118/採番/監査連鎖）
node scripts/secret-scan.mjs
BASE_URL=... SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm exec tsx scripts/smoke.ts
```

## 2. 2026-10-28 の実測結果（ローカル）

| 項目 | 結果 | 備考 |
|---|---|---|
| Typecheck（tsconfig.json / tsconfig.api.json） | **PASS** | エラー0 |
| Lint | **PASS** | 警告0（max-warnings=0） |
| Unit | **43 / 43 PASS** | 信号R1〜R6・条件チェック・ものさし・遷移・権限・承認チェック・YAML/CSV |
| Integration | **24 / 24 PASS** | 実PostgreSQL（`mirai_sf_test`）。認証/CSRF/採番/冪等/承認/差戻し/取消/版競合/出力/監査 |
| API build | **PASS** | `dist/api` 生成 |
| Web build | **未実施（承認待ち）** | `src/web` は承認後に実装 |
| DB verify | **PASS** | 19部署／118道具（青52/黄47/赤19）／採番／監査ハッシュ連鎖 |
| Secret scan | **PASS** | 追跡59ファイル |
| E2E | **未実施（承認待ち）** | Playwright設定は実装後に追加 |
| CI（GitHub Actions） | **未実行（Blocker）** | `.github/workflows/` がポリシーゲートで拒否。`docs/patches/ci.workflow.yml` を人間が適用する |

## 3. テスト構成

| ファイル | 内容 |
|---|---|
| `tests/unit/domain.test.ts` | 信号の色（R1〜R6、赤はR1/R2のみ）、合格の条件（26語・仮置き・短い・OK）、書き換え候補、ものさし、5観点、遷移表、役割権限、理由必須、承認前チェック、承認検証、あなたの番、滞留 |
| `tests/unit/output.test.ts` | 注文書YAML（項目・引用・改行・空リスト・日本語ラベル・日付）、CSV（BOM/CRLF/引用/11列）、JSON |
| `tests/integration/api.test.ts` | ログイン・401/403・CSRF、採番、信号候補、冪等キー、入力検証、承認（受付担当は不可・承認者のみ）、注文書生成、ゆるい色の理由、差戻し→再提出、取消、版競合、不正遷移、カタログ、ホーム、CSV/JSON、監査連鎖、セッション期限 |

## 4. 状態の確認（手動・E2Eで実施する項目）

| 状態 | 確認方法 |
|---|---|
| Normal | 見本9件でホーム・ボード・一覧・詳細を表示 |
| Empty | 検索0件、あなたの番0件、カタログ0件 |
| Loading | 初回表示のスケルトン、保存中の表示 |
| Validation Error | 必須不足・件名61文字・条件9件・理由必須・△未確認・赤未確認・ゆるい色の理由なし |
| Communication Error | API停止時の再試行バナー、401/403/409/500の文言 |
| Success | 登録・遷移・承認のトースト、元に戻す |

## 5. E2E（承認後）

主要3フローを Playwright で実操作する。

1. 依頼登録（7ステップ → 登録 → 受付番号）
2. 承認（内容確認中 → 承認待ち → 承認前チェック → 承認済み → 注文書YAML）
3. 進める・差し戻す（ボード/詳細 → 遷移 → 差戻し → 再提出）

## 6. CI で実行する内容（適用後）

`.github/workflows/ci.yml`（`docs/patches/ci.workflow.yml`）:
typecheck → lint → unit → migration（2回・冪等）→ seed → db:verify → integration → build → secret scan。
PostgreSQL 16 service（`mirai_sf_test`）。Required Checks にする場合は `quality` を指定。
