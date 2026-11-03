# Staging 受入確認（本番構築の前提）

最終更新: 2026-11-03 / 実施: CTO（全権委譲セッション）

## 1. 判定

**「本番前の検証環境として、条件付きで整っている」**。

- 稼働・固定リリース・バックアップ・復元・日次保守・公開境界・CI は**実測で確認できた**（下表）。
- 一方で、本番の統制に必要な次の 3 点は**未完了**で、別作業として進行中:
  1. 職務分離（複数ユーザー・自己承認の拒否）
  2. 開発ラインの AC 判定を依頼固有にする（前の依頼の試験で合格しないこと）
  3. 依存監査の CI 組込み（本 PR 群で対応中）

## 2. 実測（2026-11-03 02:30〜02:55 UTC / 11:30〜11:55 JST）

| #   | 項目                 | 実測値                                                                                  | 根拠                                                       |
| --- | -------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | 稼働 commit          | `b2ae9e32e54c97c8f34457b10f7940f21fe0c64a`（main と一致）                                | `GET http://127.0.0.1:8782/healthz` の `commit`            |
| 2   | 環境名               | `environment=staging`                                                                   | 同上。`APP_ENV=staging` が効いている                       |
| 3   | DB                   | `db.ok=true`（latency 18.4ms）                                                          | 同上                                                       |
| 4   | 固定リリース         | `current` → `releases/b2ae9e3…`（10 世代保持）                                          | `~/.local/share/mirai-sf/current` と `releases/`           |
| 5   | サービス             | `mirai-sf-api` / `mirai-sf-tunnel` / `mirai-sf-worker` すべて active                    | `systemctl --user`                                         |
| 6   | 定期ジョブ           | backup（毎日 02:30）・restore-drill（日曜 03:30）・reminders（毎日 08:30）が active     | `systemctl --user list-timers`                             |
| 7   | バックアップ         | `mirai_sf-20261102T173001Z.dump` ほか（manifest 付き、14 日保持）                       | `~/.local/state/mirai-sf/backups/`                         |
| 8   | 復元ドリル           | **OK**: 28 テーブル・監査ハッシュ連鎖 142 件・一時DB削除まで成功                        | `pnpm ops:restore-drill`（2026-11-03T02:51Z）              |
| 9   | 監査アーカイブ       | `audit-2026-10-28.jsonl.gz` 出力済み（DB の監査行は削除しない）                         | `~/.local/state/mirai-sf/audit/`                           |
| 10  | 公開境界             | 公開 URL は `302`（Cloudflare Access）／Tunnel は active                                | `curl https://sf.mirai-dx-platform.com/`                   |
| 11  | 外形監視             | `mirai-sf-healthcheck` を追加（5 分間隔）。実測で ECONNREFUSED を検知し復旧を記録       | `~/.local/state/mirai-sf/healthcheck.json`（別 PR）        |
| 12  | CI（main）           | `quality` / `e2e` / `docker` すべて success                                             | GitHub Actions run 41454083151                             |
| 13  | ブランチ保護         | `main-protection` を有効化（PR 必須・`quality`/`e2e`/`docker` 必須・bypass なし）       | リポジトリ ruleset id 26419405                             |
| 14  | 依存の脆弱性         | high / critical なし（moderate 3 件。`--prod` では 2 件）                               | `pnpm audit`                                               |
| 15  | Dependabot           | アラートと自動セキュリティ修正を有効化                                                  | GitHub API（`vulnerability-alerts` / `automated-security-fixes`） |

## 3. 未整備・制約（本番前に解消する）

| #   | 項目                                   | 状態                                                       | 影響                                                 | 対応                                       |
| --- | -------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| 1   | 職務分離（L-01 / L-02）                | 1 ユーザー・自己承認可のまま                               | 本番の承認統制（ERR-105）を満たさない                | 実装中（複数ユーザー＋自己承認拒否）       |
| 2   | AC と試験の対応（L-05）                | 試験名の `AC-n:` だけで判定                                | 前の依頼の試験が今の依頼の AC に数えられうる         | 実装中（依頼識別子＋変更ファイルで照合）   |
| 3   | Access サービストークン                | 未発行（API トークンに権限なし）                           | 公開 URL の自動 E2E・外形監視ができない              | 監視はローカル healthz で代替中。権限追加は人 |
| 4   | 実 SMTP / TLS                          | 未実測（ローカル受け皿のみ）                               | 本番の通知経路が未検証                               | 本番は `MAIL_MODE=off` を既定にする        |
| 5   | Secret scanning（GitHub）              | このリポジトリでは提供されない（422）                      | 秘密の混入検知は CI の `secret-scan` のみ            | ローカルスキャンを CI に維持               |
| 6   | 開発ラインの実 AI（修正ループ・予算）  | 正常系 2 件のみ実走                                        | 失敗経路は未検証                                     | 本番では実 runner を拒否（設計どおり）     |
| 7   | 本番公開の経路                         | 未構築                                                     | 本番は動いていない                                   | 本 ADR（`00-adr.md`）に沿って構築          |

## 4. 本番前のゲート（この順で確認する）

1. 職務分離と AC 判定の実装が main に入り、CI が緑。
2. 本番 DB・本番サービスを**ローカルに**構築し、受付→承認→注文書→Issue の通しを実測（公開はまだしない）。
3. 本番相当の設定（`NODE_ENV=production` / `APP_ENV=production` / `COOKIE_SECURE=1` / `ALLOW_SELF_APPROVAL=0` / `MAIL_MODE=off`）で起動し、`/healthz` と認証境界を確認。
4. 公開ホスト名と Access ポリシーの作成は**不可逆に近い**ため、Y/N の確認を取ってから行う。
5. 公開後は Access 越しの疎通・ログイン・受付 1 件の登録までを人の画面で確認する（OTP の受信が必要）。

## 5. 再現コマンド

```bash
# 稼働と版
curl -fsS http://127.0.0.1:8782/healthz | jq .
readlink -f ~/.local/share/mirai-sf/current

# 定期ジョブと直近の実行
systemctl --user list-timers 'mirai-sf-*'
systemctl --user status mirai-sf-api mirai-sf-worker mirai-sf-tunnel --no-pager

# 復元ドリル（一時DBを作って消す。稼働中のDBは変更しない）
pnpm ops:restore-drill

# 公開境界
curl -s -o /dev/null -w '%{http_code}\n' https://sf.mirai-dx-platform.com/

# CI とブランチ保護
gh run list --workflow=ci.yml --branch main --limit 1
gh api repos/Kensan196948G/Software-Factory/rulesets --jq '.[] | {name,enforcement}'
```
