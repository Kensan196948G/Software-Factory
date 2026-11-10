# Staging 利用者の追加と文字化け修正の本番配備（2026-11-11）

作成: 2026-11-11 JST。状態: **記録**。対象は Staging `sf.mirai-dx-platform.com`（API `127.0.0.1:8782`、DB `mirai_sf`）と本番 `sf-prod.mirai-dx-platform.com`（API `127.0.0.1:8783`、DB `mirai_sf_prod`）。時刻はすべて JST。

## 0. 所有者の指示

2026-11-11 08:16 JST、所有者が次の2件を選択した。

1. Staging への B（外部メール）の追加: **「追加する（アプリ許可リスト + mirai_sf に利用者作成 + 再起動）」**
2. 文字化け修正（PR #163）: **「CI 緑後にマージし、本番配備まで実施する」**

本書は、この指示に対する実施と実測の記録である。承認は所有者本人が行い、AI は操作を代行した。

## 1. Staging への B の追加

### 1-1. 前提（二層許可）

| 層 | 設定 | 実測 |
| --- | --- | --- |
| Cloudflare Access | アプリ `Mirai Software Factory 受付ステーション`（`5c812603-3ab8-48ba-9b72-8c5861457453`）、Allow ポリシー `ae1ab612-d6e4-4fcf-9063-27cb9616d567` | Include = `mirai-const.co.jp` / `yahoo.co.jp` / `kensan1969@gmail.com`。B の `kenaritou@yahoo.co.jp` は Access を通る（**ポリシー変更なし**） |
| アプリ | `mirai-sf-api.service`、`APP_ENV=staging`、`AUTH_MODE=access`、JWT 検証あり（`jwtConfigured=true`） | `ACCESS_ALLOWED_EMAILS` は `kensan1969@gmail.com` のみだった |

- 利用者管理での登録は `app_user` を作るだけで、Access / アプリ許可リストは変えない（`03` §5.3 の二段階）。

### 1-2. 実施

| 時刻 | 操作 | 結果 |
| --- | --- | --- |
| 08:18:40 | `~/.config/mirai-sf/preview.conf` を退避（`preview.conf.bak-20261111081840`） | 0600 維持 |
| 08:18:40 | `ACCESS_ALLOWED_EMAILS` に `kenaritou@yahoo.co.jp` を追加 | キー構成は不変。差分はこの1値のみ |
| 08:18:50 | `systemctl --user restart mirai-sf-api.service` | active、NRestarts 0。プロセス環境に新アドレス |
| 08:19:41 | `_work/create-staging-user.ts`（local-cli）で利用者作成 | 監査 `user.create` success |

作成した利用者:

| 項目 | 値 |
| --- | --- |
| email | `kenaritou@yahoo.co.jp` |
| display_name | `Kenaritou` |
| dept_code | `eigyo` |
| roles | `requester` / `desk` |
| is_admin | false |
| is_active | true |
| id | `8e98b9e7-88bf-44af-bf4d-9369e3d05d60` |

### 1-3. 検証（実測）

- `/healthz`（08:24 JST）: `status=ok`、`environment=staging`、`db.ok=true`、`auth.mode=access`、`auth.jwtConfigured=true`、`auth.headerTrustEnabled=false`、`auth.allowlistConfigured=true`、`auth.status=ready`、**`auth.usersActive=3`**（B 追加前は 2）。
- `isAccessEmailAllowed` の直接評価（稼働中 `preview.conf` を使用）: `kenaritou@yahoo.co.jp` → **true**、`kensan1969@gmail.com` → true、`someone@example.com` → **false**。
- `app_user` と `user_role`: 上表のとおり。監査 `user.create`（`local-cli uid=1000`、08:19:41）を確認。

### 1-4. 未確認・残り

- **B 本人の OTP ログインは未確認**（人間の操作）。Access（`yahoo.co.jp`）→ アプリ許可（個別メール）→ `app_user` 有効、の3条件は実測で揃っている。
- B を承認者として使う場合は `approver` ロールの追加が必要（現状 `desk` / `requester`）。

### 1-5. ロールバック

- アプリ: 退避 `preview.conf.bak-20261111081840` の `ACCESS_ALLOWED_EMAILS` に戻し、`systemctl --user restart mirai-sf-api`。
- 利用者: `app_user` を無効化（`is_active=false`）または削除。監査は追記のみ。
- Cloudflare は変更していないため戻す操作は無い。

## 2. 文字化け修正（PR #163）と本番配備

### 2-1. 症状と原因

- Access モードで認証できないとき、アプリは 401 の HTML を `Content-Type: text/html`（charset なし）で返していた。ブラウザが Shift_JIS と解釈し、UTF-8 の日本語が文字化けした。
- 修正前の実測（08:24 JST）: Staging `127.0.0.1:8782/` と本番 `127.0.0.1:8783/` はどちらも `HTTP/1.1 401` / `content-type: text/html`。
- 修正: `src/api/app.ts` の 401 応答を `text/html; charset=utf-8` にする。回帰テスト `tests/unit/access-denied-charset.test.ts` を追加。

### 2-2. PR と CI

| 項目 | 値 |
| --- | --- |
| PR | #163 `fix(web): 認証できないときの HTML に文字コードを明示する` |
| head | `a9256636ea9c62255e04e8bffe69aaa2b7b5426c` |
| PR CI | run `42921602675` success（quality 8m41s / e2e 12m29s / docker 1m3s） |
| マージ前ゲート | `node scripts/ops/pr-ready.mjs 163` → exit 0（merge_state=CLEAN、3 checks success） |
| マージ | 2026-11-11 08:35:32 JST、squash、`--match-head-commit`。merge commit `19eb80b1e9a703d7f7be59be2223ba5c7392c79b` |
| main CI | run `42924644251`（push/main、`19eb80b1`）success（quality / e2e / docker） |

### 2-3. 本番配備

- 配備承認: 2026-11-11 08:16 JST、所有者「CI 緑後にマージし、本番配備まで実施する」。
- 手順: `24-production-deploy-runbook.md`。dry-run → 本番配備 → 受入。
- dry-run（08:56:37 JST、exit 0）: `main に含まれることを確認` → `exact-main CI ゲート: 確認済み`（run `42924644251` attempt 1、quality/e2e/docker）→ `未適用の migration: なし` → `mirai-sf-prod-api.service は current を参照` → `current=bb460cb0` → `展開先=releases/19eb80b1`。
- 本番配備（08:57:08〜09 JST）:
  - 事前バックアップ `mirai_sf_prod-20261110T235655Z.dump`（138,849B、28 tables、保持 14 日、R2 OK、sha256 `93300dbd5f98..` / `f10e25293922..`）。
  - migration なし（0001〜0016 すべて skip、テーブル 28 件）。
  - `current` を `bb460cb0` → `19eb80b1` へ切替、healthz OK（commit=19eb80b1、試行 2 回目）。

### 2-4. 配備後の検証

- healthz（08:57:14 JST）: `status=ok`、`environment=production`、`commit=19eb80b1e9a703d7f7be59be2223ba5c7392c79b`、`db.ok=true`、`auth.status=ready`（mode=access、jwtConfigured=true、usersActive=3）。
- unit: `mirai-sf-prod-api` は active、MainPID 1573881、NRestarts 0、起動 08:57:08。
- 応答ヘッダ: `HTTP/1.1 401` / **`content-type: text/html; charset=utf-8`**（修正前は `text/html`）。本文は UTF-8 のまま。
- 公開 URL: 未認証で **302 → Cloudflare Access**（`sf-prod.mirai-dx-platform.com`）。
- 受入: `pnpm ops:prod:acceptance 19eb80b1…` = **PASS 14/14**。初回は healthcheck の記録が配備前（`bb460cb0`）のため 1 件 FAIL → `mirai-sf-prod-healthcheck.service` 実行後の再受入で PASS（DB: app_user=3 / audit_log=14 / request=0 / session=6 / migration 0016、R2 一致）。
- Staging: autofollow が 08:57:47 JST に `19eb80b1` へ配備。healthz `commit=19eb80b1`・`environment=staging`・`usersActive=3`、同じく `text/html; charset=utf-8` を実測。

### 2-5. 未確認・残り

- 人間 OTP 後のブラウザ表示確認（文字化けが解消して見えること）は未実施。配備後のヘッダ実測まで。
- 人的受入（P4: OTP＋別人承認＋注文書）は未実施（前版から継続）。

### 2-6. ロールバック

- 本番: `pnpm ops:prod:rollback`（直前 release `bb460cb0`、事前バックアップ `mirai_sf_prod-20261110T235655Z.dump`）。
- Staging: 次回 autofollow で main に追従する。固定で戻す場合は `MIRAI_SF_HOME` の `previous` を使う。

## 3. 参照

- `docs/production/03-business-acceptance-and-operations.md`（二段階の許可）
- `docs/production/24-production-deploy-runbook.md`
- `docs/production/26-release-status.md`（本番の正本）
- `_work/login-b-access-fix-20261110.md`（2026-11-10 の本番 B 追加）
