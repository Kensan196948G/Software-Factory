# デプロイ（Cloudflare Preview）と復旧

対象は**検証環境（Preview）のみ**。Production正式環境は本Goalの対象外。

## 1. 構成

```
Browser
  → Cloudflare Worker `mirai-sf-preview`（静的アセット + /api/* プロキシ）
  → Cloudflare Access（メールOTP、Previewホストのみ）
  → Tunnel `mirai-sf-origin` → http://127.0.0.1:8782（Node API）
  → ローカルPostgreSQL 16（127.0.0.1:5432 / mirai_sf）
```

- ローカルPostgreSQLはインターネットへ公開しない。WorkerからDBへ直接接続しない。
- Worker → origin は共有秘密ヘッダ `x-origin-secret`（`ORIGIN_SHARED_SECRET`）で保護する（`REQUIRE_ORIGIN_SECRET=1`）。
- 認証はアプリのパスワードログイン＋Cloudflare Access（前段）。片方だけに依存しない。

## 2. 事前確認（Deployment Gate）

- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` 成功
- [ ] `pnpm db:verify` 成功
- [ ] `node scripts/secret-scan.mjs` 成功
- [ ] migration が空DBから再実行できる
- [ ] Critical/High の既知問題なし
- [ ] Rollback手順を確認

## 3. 手順（初回）

```bash
# 1. 専用DB（Preview用。開発DBと分ける場合）
createdb -O "$USER" mirai_sf
MIGRATION_DATABASE_URL='postgresql:///mirai_sf?host=/var/run/postgresql' pnpm exec tsx scripts/db.ts migrate
DATABASE_URL='postgresql:///mirai_sf?host=/var/run/postgresql' MIGRATION_DATABASE_URL='postgresql:///mirai_sf?host=/var/run/postgresql' pnpm exec tsx scripts/db.ts seed

# 2. ビルド
pnpm build

# 3. origin（Node API）の systemd user unit（ポート8782）
#    ~/.config/systemd/user/mirai-sf-api.service に Environment= を列挙
systemctl --user daemon-reload
systemctl --user enable --now mirai-sf-api.service

# 4. Tunnel
cloudflared tunnel create mirai-sf-origin
# config: ~/.cloudflared/mirai-sf-origin-config.yml（ingress: mirai-sf-origin.<domain> → 127.0.0.1:8782）
cloudflared tunnel route dns mirai-sf-origin mirai-sf-origin.<domain>
systemctl --user enable --now mirai-sf-origin.service

# 5. Worker
cd worker && pnpm exec wrangler deploy
pnpm exec wrangler secret put ORIGIN_SHARED_SECRET

# 6. Access（メールOTP）
#    Cloudflare Zero Trust → Access → Applications → 新規（ホスト名: mirai-sf-preview.<domain>）
#    Allow: 管理者のメールアドレス
```

## 4. デプロイ後の確認（Deployment後に必ず実施）

1. `GET /healthz` が `status=ok` / `db.ok=true`
2. `GET /readyz` が 200
3. Preview URL のトップが表示される（CSPエラー0）
4. ログイン → ホーム → 新規 → 登録 → 承認 → 注文書 の主要フロー
5. API: `/api/home` `/api/catalog/summary` `/api/export.json`
6. DB: 作成した依頼が `request` に入り、`request_history` と `audit_log` が増える
7. Runtime: サービスログにERROR/5xxがない
8. 形状: `node scripts/smoke.ts` が全OK

## 5. 復旧 / Rollback

| 対象 | 方法 |
|---|---|
| Worker | `pnpm exec wrangler rollback`（直前のversionへ） |
| Node API | `git checkout <直前のSHA>` → `pnpm build` → `systemctl --user restart mirai-sf-api` |
| DB | migrationはadditive。障害時は `pg_restore` でバックアップから復元 |
| Tunnel | `systemctl --user restart mirai-sf-origin`。設定変更前はバックアップ |
| Access | アプリのポリシーを元に戻す（変更履歴を記録） |

**破壊的DB操作は行わない。** 復元は「別DBへ復元 → 検証 → 切替」を基本とする。

## 6. 監視（MVP）

- `/healthz` の定期確認（手動または cron）
- systemd の `Restart=always`
- 監査ログのハッシュ連鎖を `/api/audit-logs` で確認
- ログは journald（`journalctl --user -u mirai-sf-api`）。個人情報は出力しない。

## 7. 既知の制約

- Cloudflare Access のメールOTPは人間の受信が必要（自動E2Eはサービスドークンを使う）。
- ローカルホスト停止時はPreviewも停止する（仕様）。
- CIは `.github/workflows/` のポリシーゲートにより未適用（`docs/patches/README.md`）。
