# 承認プロセスの E2E（層①/②/③）

みらいSF 受付ステーションの承認プロセス（ステップ1〜ステップ9）を Playwright で検証する。
判定は再試行 0（`retries: 0`）。trace は失敗時だけ残し、レポートは HTML と JSON の両方を出す。

## 役割と層

| 層  | タグ          | 環境                                                         | ログイン                              | 実行                                  |
| --- | ------------- | ------------------------------------------------------------ | ------------------------------------- | ------------------------------------- |
| ①   | `@iso`        | 使い捨て DB・別ポート API・偽 GitHub（`AUTH_MODE=password`） | パスワード（storageState を自動作成） | `env/run-iso.ts`（全自動・OTP 不要）  |
| ②   | `@otp`        | Staging `sf.mirai-dx-platform.com`                           | Cloudflare Access の OTP（人間）      | `env/otp-login.ts` → `env/run-otp.ts` |
| ③   | `@prod-smoke` | 本番 `sf-prod.mirai-dx-platform.com`                         | Cloudflare Access の OTP（人間）      | `env/otp-login.ts` → `env/run-otp.ts` |

アカウントは 2 名だけ（管理者 = `approver` のみ・`is_admin=true` / 一般利用者 = `requester` のみ・`is_admin=false`）。
メールアドレスは環境変数（`E2E_ADMIN_EMAIL` / `E2E_USER_EMAIL`）からだけ読み、コード・commit・ログ・レポートには書かない。

## 層①（隔離環境）

```bash
E2E_ADMIN_EMAIL="$(...)" E2E_USER_EMAIL="$(...)" \
  pnpm -s exec tsx tests/e2e/approval/env/run-iso.ts
# 追加の Playwright 引数はそのまま渡る
pnpm -s exec tsx tests/e2e/approval/env/run-iso.ts -- --grep "A3 "
pnpm -s exec tsx tests/e2e/approval/env/run-iso.ts -- --repeat-each=5
```

`run-iso.ts` が作るもの:

- 使い捨て DB（`mirai_sf_approval_e2e_*`）→ migrate → seed → 2 アカウント（`createUser` / `setUserRoles` の正規経路）
- `dist/web` を HEAD からビルド（古い画面で測らない）
- 偽 GitHub（`tests/integration/fake-github-server.ts`）と制御 API
- 隔離 API（`AUTH_MODE=password` / `ALLOW_SELF_APPROVAL=0` / `MAIL_MODE=file` / `DEVLINE_RUNNER_KIND=fake`）
- 2 役分の storageState（`~/.config/mirai-sf/e2e-auth/iso-*/{admin,user}.json`、0600）
- 実行後の API 停止・DB drop・storageState 削除

## 層②③（OTP）

```bash
# 1) 人間が OTP でログイン（headed。エージェントは OTP を受け取らない・入力しない）
E2E_BASE_URL=https://sf.mirai-dx-platform.com E2E_LAYER=otp \
  E2E_ADMIN_EMAIL="$(...)" E2E_USER_EMAIL="$(...)" \
  pnpm -s exec tsx tests/e2e/approval/env/otp-login.ts

# 2) ラウンド実行（A11 ログアウトは最後に 1 回だけ）
E2E_BASE_URL=https://sf.mirai-dx-platform.com E2E_LAYER=otp \
  pnpm -s exec tsx tests/e2e/approval/env/run-otp.ts
```

- storageState はリポジトリ外 `~/.config/mirai-sf/e2e-auth/{admin,user}.json`（0600）。成功したラウンドの後に削除する。
- `run-otp.ts` はまず A11 以外を通し、成功したときだけ A11（ログアウト）を実行する。失敗時は storageState を残す。
- 本番で作る依頼の件名は `【検証】YYYY-MM-DD` で始め、確認後に理由付きで取消す（削除しない）。
- 誤爆防止のため、`E2E_BASE_URL` が想定ホストでない場合は起動しない（`E2E_ALLOW_ANY_BASE=1` で明示解除）。

## 証跡

- `test-results/approval/evidence/*.json` — テストごとの判定・4xx/5xx・pageerror・実測メモ
- `test-results/approval/html` — HTML レポート、`test-results/approval/results.json` — JSON レポート
- 層①は `test-results/approval/iso-summary.json`（環境・手順・後片付け）と `logs/`（migrate/seed/API/db:verify）
- 5xx と pageerror は自動フィクスチャが 0 件を強制する（4xx は拒否・監査の実測値として記録のみ）。

## テストの構成

| ファイル                   | 内容                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `01-p0-create.spec.ts`     | A1（登録・受付番号・再読み込み）                                                                       |
| `02-p0-approve.spec.ts`    | A3（承認・注文書の版）/ A4（赤の確認）/ A5（緩い色の理由）/ A7（自己承認）                             |
| `03-p0-exceptions.spec.ts` | A2（飛ばし遷移）/ A6（利用者は承認不可）/ A8（編集→再承認）/ A9（差戻し・再提出）/ A10（見送り・取消） |
| `04-p1-station.spec.ts`    | B1（同時承認）/ B2（監査 403・役割切替）/ B3（無効化でセッション失効）                                 |
| `05-devline.spec.ts`       | B4（Issue 投入）/ B5（merge 承認・SHA）/ B6（配備 digest・戻し）                                       |
| `06-known-holes.spec.ts`   | C1/C2（既知の穴。`test.fail()`）                                                                       |
| `09-p0-audit.spec.ts`      | A12（監査とハッシュ連鎖。層①は `db:verify` も実行）                                                    |
| `10-p0-logout.spec.ts`     | A11（ログアウト後の再アクセス。`@logout-last`）                                                        |
