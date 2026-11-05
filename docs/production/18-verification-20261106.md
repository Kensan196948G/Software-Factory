# Staging・本番の再検証と Issue #102 のコード修正（2026-11-06）

作成: 2026-11-06 JST。対象は **Staging と本番の技術的な再検証**、および **Issue #102 のコード側の恒久修正**である。本番・Staging の設定・サービス・DB は変更していない（読取りとコードの PR だけ）。

- 数値は実測の転記である。実測は Lead（AI）と、独立した読取り専用の担当（staging-auditor / prod-auditor / integration-scout）が行った。作業記録は `_work/staging/verify-20261106.md`、`_work/prod/verify-20261106.md`、`_work/integration/status-20261106.md`。
- 秘密・JWT・cookie・接続文字列・メールアドレス・設定値は書かない。識別は SHA-256 の先頭 8 桁か commit の短縮形だけを使う。

## 1. Staging の実測（06:24〜06:29 JST）

| 確認               | 結果                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `/healthz`         | 200。`status=ok`、`environment=staging`、`commit=2d0766b…`、`db.ok=true`（0.5ms）                     |
| `/readyz`          | 200。`status=ready`、`db.ok=true`（0.7ms）。readyz は commit / environment を返さない（未確認）        |
| mirai-sf-api unit   | active/running、NRestarts=0、起動 2026-11-06 05:10:01、MainPID 4095007、enabled                       |
| mirai-sf-worker    | active/running、NRestarts=0、起動 2026-11-05 22:20:28、MainPID 733720。**05:10 の切替時に再起動されていない** |
| プロセス環境の名前 | `ACCESS_TEAM_DOMAIN` = present、`ACCESS_AUD` = present（**値は非出力**）                              |
| journal（05:10 以降） | api 95 行、level≥50 = 0、statusCode 200=35 / 401=7 / 503=1。503 は 05:10:01（API 起動と同一秒）       |
| 「ヘッダのメールを信頼」 | api・worker・healthcheck とも **0 件**。user journal 全体の 13 箇所は systemd がコマンドラインを記録した汚染で、根拠に使えない |
| alerts.jsonl       | 3 行、最終 `at=2026-11-05T20:10:01Z`、`unit=mirai-sf-healthcheck.service`                              |
| DB `mirai_sf`（READ ONLY） | session 0 / app_user 2 / user_role 6 / request 12 / audit_log 142（最大 id 142）/ schema_migrations 16（最大 0016） |
| 本番非変更         | prod-api PID 830351・NRestarts=0・起動 22:30:49、prod-tunnel 1344014、prod.conf mtime 11-03 21:02:01、unit hash d38ca8c3 / 4b2f2b5f。05:16 のベースラインと一致 |

判定: 05:10 の JWT 切替と 05:14 の旧セッション削除の後も、Staging の主要な指標は整合している。**正規の OTP ログイン（有効な JWT でのログイン）は未確認**（人がブラウザで実施する必要がある）。

## 2. 本番の技術受入（06:24〜06:28 JST）

| # | 確認 | 結果 |
| - | ---- | ---- |
| 1 | `/healthz` | 200。`status=ok`、`environment=production`、`commit=2d0766b…`、`db.ok=true`（0.5ms）。current = releases/2d0766b（14 世代） |
| 2 | unit | prod-api: active/running/enabled、NRestarts=0、起動 2026-11-05 22:30:49、Result=success/0、MainPID 830351。prod-tunnel: active/running/enabled、NRestarts=0、起動 2026-11-03 16:03:13 |
| 3 | prod.conf | mode 600、1,068 B、mtime 2026-11-03 21:02:01、28 キー。**`ACCESS_TEAM_DOMAIN` と `ACCESS_AUD` のキーは存在**（各 1・非空。値は非出力） |
| 4 | journal 05:00 以降 | prod-api 65 行、statusCode は 200 のみ 26 件、**5xx=0**、level≥50=0。backup / healthcheck / tunnel の err も 0、failed unit 0 |
| 5 | バックアップ / R2 | 最新 dump `mirai_sf_prod-20261105T204030Z.dump`（137,767 B、05:40:31）+ manifest.tsv（457 B、29 行）。r2.json の uploadedAt = 05:40:44（計測時 47 分前、閾値 90 分未満）、size と SHA-256 はローカルと一致。backup success/0 |
| 6 | DB `mirai_sf_prod`（READ ONLY） | session 2（期限内 0）、app_user 2（is_admin 1）、request 0、audit_log 9（最大 id 9）、schema_migrations 16（最大 0016） |
| 7 | 公開 URL | 未認証 GET 1 回 → **302**（`*.cloudflareaccess.com` のログインへ）。クエリは記録しない |

判定: **本番の技術受入 7 項目は PASS**。healthcheck の warnings 1 件は「デプロイ commit 2d0766b ≠ origin/main cbf7bc7」という main 前進による既知の警告で、FAIL ではない。

**Issue #102 の本番リスク**: 本番 conf に JWT の 2 キーが存在し、稼働プロセスの環境にも両キーがある。起動以降の journal に「ヘッダのメールを信頼」警告 0・JWKS 取得失敗 0。よって **本番は「キー欠落→ヘッダ信頼→管理者自動登録」の条件が成立していない**。値そのもの・Access 側 AUD との一致・正規 OTP ログインは未確認。

## 3. Issue #102 のコード修正（未配備）

- 変更: `src/api/config.ts` / `src/api/auth.ts` / `tests/unit/access-jwt.test.ts` / `tests/integration/access-jwt.test.ts`。
- 内容: JWT 未設定時の Access ヘッダ信頼を**既定で無効**（fail-closed）。`ACCESS_TRUST_EMAIL_HEADER=1` の明示 opt-in がある、**APP_ENV を明示した**開発・テスト環境だけ従来動作。`APP_ENV=staging` / `production`、`NODE_ENV=production`、**APP_ENV 未設定**での `1` は起動エラー。`AUTH_MODE=password` では値自体を使わない（JWT 設定と同じ扱い）。JWT が有効なときの経路は不変。
- 独立レビュー（実装者とは別担当）の結果: **PASS-WITH-LIMITS（Critical 0 / High 0 / Medium 3 / Low 6）**。Medium のうち次を本 PR で反映した: (a) 配備前に発行済みセッションを失効させる手順の明記、(b) APP_ENV 未設定時の opt-in を起動エラーに変更（実測で development 扱いになっていたため）、(c) Issue #102 の残り半分（JWT 有効時の Staging 自動管理者作成）は未修正であることの明記。残る Low は将来の改善（`AUTH_MODE` の typo フォールバック等）。
- 検証（Lead が同一 commit で再実行）: `tsc`（tsconfig.json / tsconfig.api.json）exit 0、`eslint . --max-warnings=0`（`.agents/**` を ignore に追加後）exit 0、`vitest` の access-jwt + config = **74/74 pass**（レビュー反映後に再実行）。担当の実測では単体全 850 件・対象結合 14 件も pass（全結合スイート・build・e2e は未実行）。
- 独立レビュー（第 2 回・PR head `cd8c09a`、読み取り専用の別担当）: **PASS-WITH-LIMITS（Critical 0 / High 0 / Medium 0 / Low 7）**。要求観点 (a)〜(i) をコード読取りと `loadConfig` プローブで確認し、CI run 42116689994（head 一致）の成功と、独立再実行（tsc 2 構成・eslint・unit 74/74）を照合した。Low の内訳と対応:
  - 対応した: 切り戻し手順（`17` §7）が本修正の配備後は誤りになる点、`APP_ENV` 未設定の限定条件が暗黙である点（`api.md` / `deployment.md`）、起動時テストの欠落（`NODE_ENV=production` × `APP_ENV` 明示で拒否・`APP_ENV=test` 明示で許可）、`config.ts` のコメント不整合 2 件、`setup-preview.mjs` が JWT 未設定のまま「ログイン全断」の conf を無言で作る点（警告と環境変数注入を追加）。
  - 残す: fail-closed は新規認証のみで既存 Cookie は TTL（既定 12h）内有効。失効は配備手順（`deployment.md` の切替手順 4）で行う。コードによる自動失効はしない。
  - 残す: 本番で JWT が欠落しても `/healthz` は 200 を返すため、外形監視では「認証全断」を検知できない。監視項目の追加は別タスク（Batch 2 候補）。
- **未配備**: 本番・Staging の設定・サービス・DB は変更していない。配備するまで稼働中の挙動は変わらない。
- 残り: 正規 JWT 経路で Staging の未登録メールを管理者として自動作成する点は未修正（別タスク）。→ §7 の別 PR で是正した（既定 off・opt-in 時も最小権限）。

## 4. 他リポジトリ連携の実測（06:24〜06:31 JST）

| repo | PASS/FAIL | FAIL の項目 | 2026-11-05 との差 |
| ---- | --------- | ----------- | ----------------- |
| Software-Factory-Sandbox | 7 / 1 | `required_checks`（main が未保護） | なし |
| Development-Dispatcher | 6 / 2 | `required_checks`、`ac_results` | latest_ci の run ID のみ前進、success 維持 |
| dd-e2e-sandbox | 6 / 2 | `required_checks`、`ac_results` | なし |
| AI-Company-Control-Center | 7 / 1 | `ac_results` | latest_ci の run ID のみ前進、success 維持 |

- Development-Dispatcher の ADR-0009 は **Proposed のまま**（ACCC 分は実物検証済み、Harness 分は仮定）。ACCC 側の ADR-0009 も Proposed。
- Sandbox の open PR は **#3 のみ**（mergeable=clean、check 6/6 success、2026-10-31 から open のまま）。
- ACCC 側は受信契約（`POST /api/v1/integrations/events`、service principal `events:ingest`）を実装済みだが、**SF 側に送信実装は無い（`src/` の参照 0 件）**。SF 側の契約（何を送るか・署名鍵・主体）は未定義。
- **今すぐ SF 側で実装できるコード連携は 0 件**。人間判断が必要な項目は §5 に整理した。

## 5. 未確認・残リスク・人間判断

| 区分 | 内容 |
| ---- | ---- |
| 未確認 | 正規 OTP ログイン（Staging / 本番）、Access 側 AUD と conf の値の一致、R2 バケット上のオブジェクト実在、別ホストでの DR |
| 残リスク | Staging の未登録メール自動管理者作成（正規 JWT 経路。§7 でコード是正・未配備）、単一ホスト障害点、業務受入（ケース S / B）未実施 |
| 人間判断 | Sandbox の main 保護（N8）、Sandbox PR #3 の扱い、N6 資格情報 rotation、N7 R2 保持、外部通知先、別ホスト DR の要否、DD / ACCC 連携の範囲 |

## 6. 変更していないもの

本番・Staging の設定ファイル、systemd unit、DB、Cloudflare（Access / DNS / Tunnel / R2）、GitHub のリポジトリ設定・ブランチ保護、他リポジトリ。コードは PR のブランチのみで、main へは正規の CI・レビュー後にマージする。

## 7. 未登録利用者の自動作成を最小権限・opt-in 化（2026-11-06・コードのみ）

Issue #102 完了条件 3 の残り（正規 JWT 経路で Staging の未登録メールを管理者として自動作成する点）を、別 PR のコードで是正した。本番・Staging の設定・サービス・DB は変更していない。

- 変更: `src/api/config.ts` / `src/api/auth.ts` / `tests/unit/access-jwt.test.ts` / `tests/integration/access-jwt.test.ts` / `docs`。
- 設定: `ACCESS_AUTO_PROVISION` を追加。既定 `0`（未設定＝無効）。`0` / `1` 以外と、本番・staging（`NODE_ENV=production` を含む）での `1` は起動エラー。runtime 側でも同じ条件で無効化し、起動時判定と二重に守る。
- 無効時: 未登録の利用者は 401 とし、`auth.access_denied`（reason=`user_not_registered`）を監査に残す（従来の本番挙動と同じ）。
- 有効時: 作るのは `is_admin=false`・`requester` のみ（最小権限）。`user.provisioned`（isAdmin=false, roles=['requester']）を監査に残す。利用者・ロール・監査は同一トランザクション。
- 回帰試験（隔離したローカル test DB）: 既定 off で未登録 → 401・`app_user` / `session` 非作成・`auth.access_denied`。`APP_ENV=staging` でも同様。opt-in で作成され `is_admin=false` / `requester` のみ / `user.provisioned`。opt-in を無効に戻しても既存利用者はログイン可。
- 起動時エラー: 単体テストで `APP_ENV=staging` / `production`、`NODE_ENV=production`、`0` / `1` 以外を固定。
- 配備上の注意: 配備後は Staging でも未登録の利用者が 401 になる。必要な利用者は管理API（`/api/admin/users`）で事前に作成する。`ACCESS_AUTO_PROVISION=1` は開発・テスト専用で、staging / production では設定しない（起動エラーになる）。
