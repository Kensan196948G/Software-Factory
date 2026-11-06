# 本番配備当日の手順（承認後）

作成: 2026-11-06 JST。状態: **手順書**（本番は未配備・所有者の承認待ち）。
対象: 本番（`sf-prod.mirai-dx-platform.com`、API `127.0.0.1:8783`、DB `mirai_sf_prod`）。

- 本書は 2026-11-06 までに実証した結果だけを手順化した。実測の出典は `docs/production/20`〜`23` を参照する。
- 秘密・個人情報・接続文字列は書かない。識別は短縮 SHA を使う。
- 各ステップで「期待する結果」と「中止条件」を明示する。**中止条件に当てはまったら止めてロールバックする**。

## 0. 前提条件（すべて満たすこと）

| # | 条件 | 確認方法 | 2026-11-06 時点 |
| - | ---- | -------- | --------------- |
| 1 | 所有者の配備承認（数字選択または Y/N） | 会話・記録 | **未取得** |
| 2 | main が緑（必須 CI 3/3） | `gh run list --branch main --limit 1` | 成功 |
| 3 | 未適用の migration がない | `ops:prod:release --dry-run <SHA>` | 0 件 |
| 4 | 最新バックアップと R2 記録が新しい | `pnpm ops:prod:offsite-status --count 2` | OK |
| 5 | ロールバック手順が使える | `pnpm ops:prod:rollback --dry-run <前SHA>` | exit 0 |
| 6 | 監視が動いている | `systemctl --user show mirai-sf-prod-healthcheck.service -p Result` | success |

## 1. 配備対象の確定

```bash
cd /mnt/storage/Software-Factory/Software-Factory
git switch main && git pull --ff-only
SHA=$(git rev-parse HEAD)
echo "$SHA"
pnpm ops:prod:release --dry-run "$SHA"
```

- **期待**: `main に含まれることを確認` → `exact-main CI ゲート: 確認済み` → `未適用の migration: なし` → `計画: archive → install → build → backup → migrate → 切替 → 再起動 → healthz`、exit 0。
- **中止**: CI ゲート未確認、未適用 migration がある、unit が current を参照していない。

## 2. 事前バックアップと基準値の記録

```bash
pnpm ops:prod:backup
pnpm ops:prod:offsite-status --count 2
curl -s http://127.0.0.1:8783/healthz
systemctl --user show mirai-sf-prod-api.service -p MainPID -p NRestarts -p ExecMainStartTimestamp
```

- **記録する**: 最新 dump の世代名とサイズ、healthz の commit / environment / db.ok、API の MainPID と起動時刻、DB 件数（`app_user` / `audit_log` / `request` / `session` / `migration`）。
- **中止**: バックアップが失敗、R2 記録が 90 分超、healthz が 200 以外。

## 3. 配備（切替）

```bash
pnpm ops:prod:release "$SHA"
```

- **期待**: release 作成 → 事前バックアップ → 切替 → 再起動 → `healthz OK（commit=$SHA）` で exit 0。
- **中止（自動または手動でロールバック）**: 起動失敗、healthz の commit 不一致、healthz が 200 以外、unit が failed。

## 4. 機械的受入（必須）

```bash
pnpm ops:prod:acceptance "$SHA"
```

- **期待**: 14 項目すべて `PASS`、exit 0。特に `auth.status=ready` と `auth 関連の警告が無い` を確認する。
- **中止**: 1 項目でも FAIL → §7 のロールバックへ。**FAIL のまま業務確認へ進まない**。
- 補足: `--json` で機械可読の結果を保存できる。

## 5. 人の操作による受入（§4 の残り）

| # | 確認 | 期待 |
| - | ---- | ---- |
| 1 | 公開 URL へ未認証でアクセス | Access のログインへ 302 |
| 2 | `Cf-Access-Authenticated-User-Email` を付けて `/api/auth/me` | 401（JWT 検証が有効なため） |
| 3 | 正規の OTP ログイン（ブラウザ） | 画面が表示され、管理画面に入れる |
| 4 | 受付 1 件の登録 → 承認 → 注文書 YAML | 画面で完了し、監査に残る |
| 5 | 自己承認（同一ユーザー） | ERR-105 で拒否 |
| 6 | `journalctl --user -u mirai-sf-prod-api --since …` | 5xx / ERROR が出ていない |

- **中止**: 1〜5 のいずれかが期待と異なる → 原因を切り分け、設定起因なら設定を戻し、コード起因なら §7 のロールバック。

## 6. 記録

`docs/production/25-production-release-<日付>.md` を新規作成し、次を残す。

- 対象 SHA、実施時刻、実行者
- 事前バックアップの世代名・サイズ、R2 記録
- `ops:prod:acceptance` の出力（PASS の内訳）
- 人の操作項目の結果
- 配備前後の DB 件数、healthcheck の状態
- 未確認事項・残リスク

## 7. ロールバック（中止条件に当てはまったとき）

```bash
pnpm ops:prod:rollback --dry-run <前のSHA>   # 計画の確認
pnpm ops:prod:rollback <前のSHA>             # 切替（DB は戻さない）
pnpm ops:prod:acceptance <前のSHA>           # 戻した先の受入
```

- **期待**: 切替は数秒（Staging の訓練では片道約 1 秒）、healthz の commit が前の SHA と一致、受入が PASS。
- **注意**: DB は戻さない（migration は additive のみ）。今回の配備は未適用 migration 0 のため実害はない。
- **記録**: ロールバックした理由・時刻・戻した先・受入結果を §6 と同じ文書に残す。

## 8. 事後の観察

- `mirai-sf-prod-healthcheck` が 5 分間隔で success を継続すること（最低 1 時間）。
- `mirai-sf-prod-backup` が次の定時（55 分間隔）で成功し、R2 記録が更新されること。
- 失敗通知: `~/.local/state/mirai-sf/alerts.jsonl` に新しい行が増えないこと（外部通知は未設定）。
- 監査: `audit_log` の件数が増えること（ログイン・操作）。

## 9. 既知の制約（配備前後で変わらないもの）

- 正規 OTP ログインは人が必要（AI は代行しない）。
- 外部通知は未設定（失敗はローカル記録のみ）。
- 別ホスト DR は未実証（R2 からの復元は同一ホストで実証済み）。
- R2 の保持規則は未設定（N7 未適用）。
- 既存の管理者 2 件（`is_admin=true`・3 役）の棚卸しは未実施（`ops:user-inventory` で確認可能）。
