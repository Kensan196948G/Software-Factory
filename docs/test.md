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
node scripts/ops/healthcheck.mjs   # Staging外形監視（正常時 exit 0 / 失敗時 exit 1）
BASE_URL=... SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm exec tsx scripts/smoke.ts
```

## 2. 実測結果（2026-10-28）

本節は 2026-10-28 時点の履歴である。最新は CI と品質工作台のテストレポートを正とする（下表の件数を現在の値として引用しない）。

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

## 6. Staging 外形監視（healthcheck）の実測（2026-11-03）

対象は稼働中の Staging（`127.0.0.1:8782`、current / origin/main / `/healthz` の commit はいずれも `b2ae9e3…`）。実行は worktree（`auto/staging-healthcheck`）から `node scripts/ops/healthcheck.mjs`。**稼働中の `mirai-sf-api` / `mirai-sf-tunnel` / `mirai-sf-worker` は停止・再起動していない。** Node は v22.22.3。

### 6-1. 正常系

| 確認項目                | 実測結果                                                      |
| ----------------------- | ------------------------------------------------------------- |
| `/healthz`              | HTTP 200 / `status=ok` / `db.ok=true` / `environment=staging` |
| `commit` と release.env | 一致（`b2ae9e32e54c97c8f34457b10f7940f21fe0c64a`）            |
| `origin/main`（任意）   | 一致（同じ SHA）                                              |
| 終了コード              | **0**                                                         |
| 状態ファイル            | `ok=true` / `consecutiveFailures=0`（0600）                   |

```text
[...] healthcheck 開始: url=http://127.0.0.1:8782/healthz
[...] origin/main と一致: b2ae9e32e54c97c8f34457b10f7940f21fe0c64a
[...] healthcheck OK（commit=b2ae9e32e54c97c8f34457b10f7940f21fe0c64a, environment=staging, db.ok=true, 72ms）
```

### 6-2. 失敗系（`MIRAI_SF_HEALTH_URL` を一時的に接続不可の URL へ）

正常な unit を止めずに失敗系を確認するため、`MIRAI_SF_HEALTH_URL=http://127.0.0.1:59999/healthz` を指定して手動実行した（59999 は待ち受けなし。URL の差し替えは `docs/deployment.md` §7-4 の `MIRAI_SF_HEALTH_URL` と同じ）。

| 確認項目     | 実測結果                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 出力         | `NG: healthz へ接続できません（ECONNREFUSED）` → `NG: healthcheck NG（連続 1 回目）`                                   |
| 終了コード   | **1**                                                                                                                  |
| 状態ファイル | `ok=false` / `consecutiveFailures=1` / `totalFailures=4`（実測を重ねた累計）/ `lastFailureAt=2026-11-03T02:46:34.000Z` |
| 秘密情報     | 出力・状態ファイルに設定値・トークンは出ていない                                                                       |

```text
[...] healthcheck 開始: url=http://127.0.0.1:59999/healthz
[...] NG: healthz へ接続できません（ECONNREFUSED）
[...] NG: healthcheck NG（連続 1 回目）
[...] NG: 確認: journalctl --user -u mirai-sf-healthcheck / systemctl --user --failed
```

### 6-3. 復旧系（恒常 URL に戻して再実行）

| 確認項目     | 実測結果                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| 出力         | `復旧: 連続 1 回の失敗から回復しました（最終失敗 2026-11-03T02:46:34.000Z）` の1行＋`healthcheck OK`    |
| 終了コード   | **0**                                                                                                   |
| 状態ファイル | `ok=true` / `consecutiveFailures=0` / `lastIncidentFailures=1` / `recoveredAt=2026-11-03T02:46:34.133Z` |

```text
[...] 復旧: 連続 1 回の失敗から回復しました（最終失敗 2026-11-03T02:46:34.000Z）
[...] healthcheck OK（commit=b2ae9e32e54c97c8f34457b10f7940f21fe0c64a, environment=staging, db.ok=true, 71ms）
```

### 6-4. 確認項目ごとの異常検知（ローカル stub で確認）

`127.0.0.1:8783` に一時的な stub を立て、`status=degraded` / `db.ok=false` / `environment=production` / `commit=1111…` を返した。終了コード 1 で、次の4件を同時に検出した（状態ファイルは一時ファイルへ差し替え）。

- `status=degraded（ok を期待）`
- `db.ok=true ではありません（DB 接続に失敗している可能性）`
- `environment=production（staging を期待）`
- `commit が一致しません（healthz=1111…, release.env=b2ae9e3…）`

`MIRAI_SF_REPO` に `origin/main` が別 SHA の一時リポジトリを指定した場合は、**exit 0 のまま warning だけ**を出し、`~/.local/state/mirai-sf/healthcheck.json` の `warnings` に記録された（release 反映漏れの検知）。

URL に資格情報とクエリ（`http://user:<token>@127.0.0.1:8782/healthz?token=<token>`）を入れて実行しても、ログ・状態ファイルの URL は `http://127.0.0.1:8782/healthz` に落ち、`grep` で値が出ないことを確認した。

### 6-5. systemd 連携の確認（`~/.config/systemd/user/` へは未配置）

- `systemd-analyze calendar '*:0/5'` → `Normalized form: *-*-* *:00/5:00`（5分ごと）。`systemd-analyze --user verify deploy/systemd/mirai-sf-healthcheck.service deploy/systemd/mirai-sf-healthcheck.timer` はエラーなし。
- 失敗の可視化は、設定ファイルを置かない一時 unit（`systemd-run --user`）で実測した。`WorkingDirectory` と `PATH` は unit 雛形と同じ条件。
  - 失敗時: `systemctl --user --failed` に `mirai-sf-healthcheck-selftest-ng.service loaded failed failed` が表示され、`journalctl --user -u …` で NG 行、`systemctl --user show` で `Result=exit-code` / `ExecMainStatus=1` を確認。確認後 `systemctl --user reset-failed` で消えた（`LoadState=not-found`）。
  - 成功時: `Result=success` / `ExecMainStatus=0`、journal に `healthcheck OK` を確認。`--collect` により unit は自動で消えた。
- 本番の unit 配置・timer 有効化は Lead が行う（この作業では `~/.config/systemd/user/` へコピーしていない）。有効化後の5分周期・復旧時の failed 解消は、`docs/deployment.md` §7-4 の手順で確認する。

### 6-6. 静的検証

| 項目         | 結果                                                              |
| ------------ | ----------------------------------------------------------------- |
| typecheck    | **PASS**（`pnpm typecheck`、エラー0）                             |
| lint         | **PASS**（`pnpm lint`、警告0）                                    |
| Prettier     | 変更ファイルは `prettier --check` で整形済み                      |
| 既存ユニット | 停止・再起動なし（`mirai-sf-api` / tunnel / worker は稼働のまま） |

## 7. アクセシビリティ自動検査（2026-11-04 追加）

### 7-1. 実行方法

```bash
# 承認者回帰 + アクセシビリティ（同じサーバ不要・全通信横取りの config）
pnpm test:browser:approver

# アクセシビリティだけ
pnpm exec playwright test --config playwright.approver.config.ts tests/browser/a11y.spec.ts

# 既存の E2E 一式（tests/e2e/a11y.spec.ts 経由で同じ5件が加わる）
pnpm test:e2e
```

`playwright.approver.config.ts` の `testMatch` は承認者・a11y・利用者管理を対象とし、`8a1ee99` 時点で
**承認者回帰 16 件 + アクセシビリティ 5 件 + 利用者管理 9 件 = 30 件**を実行する。
既存の `tests/e2e/approver.spec.ts` / `tests/e2e/a11y.spec.ts` に加え、`tests/e2e/admin-users.spec.ts` から同じ管理UI9件を読み込む。
CIのworkflow・必須チェック規則は変更しない。通常のe2e設定でも各specを収集する（追加の9件は `--list` で確認）。
CI の E2E ジョブは `pnpm install` で `@axe-core/playwright` を入れるため、追加の設定は要らない。

### 7-2. 対象と方式

| #   | 画面                      | 起点                                                             | axe の範囲     |
| --- | ------------------------- | ---------------------------------------------------------------- | -------------- |
| 1   | ログイン                  | `src/web/public/login.html` + `login.js`                         | ページ全体     |
| 2   | コンソール初期表示        | `src/web/index.html` + `bridge.js` / `console.js`（boot を注入） | ページ全体     |
| 3   | 依頼詳細                  | 一覧の行を開いたドロワー `#drawer`                               | `#drawer` のみ |
| 4   | 注文書タブ                | ドロワーの `[data-dt="yaml"]`                                    | `#drawer` のみ |
| 5   | 承認者選択（ウィザード6） | 「新しい依頼」→ 道具 → … → 承認者選択                            | ページ全体     |

- 既存の `tests/browser/approver.spec.ts` と同じく、`page.route('**/*')` で全通信を横取りする。実サーバ・DB・メール・本番/Staging には接続しない。
- データはすべて作り物（`架空 同名` / `first@example.com` 等）。実データは使わない。
- 画面遷移の `opacity` アニメーション中に測ると、半透明の色がコントラスト違反として誤検出される。`settle()` で有限のアニメーション完了後に測る（無限アニメのバッジは対象外）。

### 7-3. 合否の基準

- **失敗にするのは axe-core の `serious` / `critical` だけ。** `moderate` / `minor` は合否に使わない（既存画面の moderate を緑にするために重大度フィルタを緩めない）。
- 既知の除外は「画面 + ルールID + 対象要素」の3点で最小に絞る（`KNOWN_EXCLUSIONS`）。同じルールでも別要素の違反は失敗する。
- 検査が空振りしていないことを `results.passes.length > 0` で確認する。

### 7-4. 既知の除外（allowlist）

| #   | 画面           | ルール                      | 対象                                 | 理由（実測）                                                                             | 解消先           |
| --- | -------------- | --------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------- |
| 1   | 全画面         | color-contrast              | `.offline`                           | 「完全オフライン」バッジ 3.04:1（#1f9d55 on #e1f4e8）。配色は原本側。                    | W-10 / Backlog 6 |
| 2   | コンソール初期 | color-contrast              | `.tm > .kd`（4ノード）               | 運用タイルの種別チップ 2.87:1（11px 太字）。文字が小さく原本の意匠。                     | W-10 / Backlog 6 |
| 3   | 承認者選択     | color-contrast              | `.big > small`                       | 見出し横「時間／月」3.32:1（13px 太字）。補助表示。                                      | W-10 / Backlog 6 |
| 4   | 承認者選択     | label                       | `input[type="date"]`                 | 希望時期の日付入力に可視ラベルが無い（placeholder も空）。                               | W-10 / Backlog 6 |
| 5   | 承認者選択     | label                       | `#att`                               | 添付ファイル入力に可視ラベルが無い。選択後は `#attL` にファイル名を表示する作り。        | W-10 / Backlog 6 |
| 6   | 承認者選択     | scrollable-region-focusable | `dl`（`.order dl`）                  | 注文書プレビュー（max-height 330px + overflow:auto）にキーボードのフォーカスが乗らない。 | W-10 / Backlog 6 |
| 7   | 承認者選択     | select-name                 | `select[data-bind="approverUserId"]` | 承認者選択の select にアクセシブル名が無い。直前に見出しはあるが名前は未設定。           | W-10 / Backlog 6 |

除外は「テストを緩める」ためではなく、原本（ベンダー扱い、W-05）の改変を最小にするための既知リストである。
解消するときは `KNOWN_EXCLUSIONS` の該当行を消し、`pnpm test:browser:approver` が失敗することを確認してから直す。

### 7-5. 実測結果（2026-11-04）

| 項目                         | 結果                                                                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:browser:approver` | **30 / 30 PASS**（承認者16 + a11y5 + 管理UI9、skip 0。管理UI9は PR #86 で追加、PR #88 で必須E2Eへ読込み。旧 21/21 は管理UI追加前の記録）                                                            |
| アクセシビリティ5画面        | **5 / 5 PASS**（serious/critical 0。除外は上表の7件のみ）                                                                                                                                           |
| `pnpm typecheck`             | **PASS**（エラー0）                                                                                                                                                                                 |
| `pnpm lint`                  | **PASS**（警告0、max-warnings=0）                                                                                                                                                                   |
| `pnpm test:unit`             | **644 / 644 PASS**（18ファイル）                                                                                                                                                                    |
| 検出確認（mutation check）   | allowlist を一時的に外すと `.offline` の color-contrast で**失敗**することを確認（空振りしない）                                                                                                    |
| `pnpm test:e2e`（全体）      | 必須e2eジョブで実行（exact-head CI）。デフォルト収集139件＋管理UI9件の読込み＝**148件**（skip 1はAccess資格情報が無い既存項目）。ブラウザ設定の30件はサーバ不要で、うち管理UI9件を必須E2Eにも読込み |

CI のステップ名は `E2E（9シナリオ）` のまま（workflow を変更しない方針）だが、実行内容は
デフォルトの全 E2E＋読込み9件であり、名称は実態より小さい。workflow を触る別作業で名称を直す。

### 7-6. 制限

- axe-core の自動検査は、色・名前・構造など機械的に判定できる範囲だけ。読み上げ順の自然さ・業務文脈の分かりやすさ・キーボード操作の実走は検査しない。
- 上表の7件は自動検査では検出されない（既知の負債）。Backlog 6 で解消する。
- `moderate` / `minor` は合否にしないため、増えても気づかない。必要なら別途レポート化する。
