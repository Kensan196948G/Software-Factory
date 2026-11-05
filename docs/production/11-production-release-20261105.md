# 2026-11-05 本番リリース（07613ce）と技術受入の記録

## 状態と範囲

- 2026-11-05 15:37 JST、本番（`127.0.0.1:8783` / `mirai_sf_prod`）を `8a1ee9931e5838234a4f5da86f5e598f7d95100a` → `07613cefba43b7e3b2dd732d0c616f61a1300c52` へ更新した。
- 所有者の委任（2026-11-05「CTO に全権委譲」）に基づき Lead（AI）が実施した。人間 OTP 後の別人 2 名による業務受入は**未実施**であり、本書は**技術受入**の記録である（業務受入の代替ではない）。
- 公開範囲・Access・DNS・資格情報・prod.conf は変更していない。

## 前提として確認した Staging

| 時点     | 対象 SHA  | 結果                                                                                                      | 根拠                                     |
| -------- | --------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 14:0x    | `56a5810` | 独立検証 PASS 11 / FAIL 1（4b は基準誤り。Staging は `AUTH_MODE=access` 運用で未認証 `/` は 401 が正）    | `_work/staging-verification-20261105.md` |
| 15:30:49 | `07613ce` | autofollow が exact-main CI ゲート OK（run 41977905186 attempt 1）→ 配備成功。独立再検証 PASS 14 / FAIL 0 | 同上「07613ce 再検証」節                 |

## 本番に含めた変更（56a5810 からの差分を含む）

| PR                    | 内容                                                                                                     | 独立レビュー                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| #87（既マージ）       | 一覧の信号絞り込みを SQL へ。migration `0016_list_created_index`（部分 index 追加）                      | 2026-11-04 実施済み                                      |
| #88 / #89（既マージ） | 管理UI E2E の必須化 / Staging autofollow の exact-main CI ゲート                                         | 2026-11-04 実施済み                                      |
| #90                   | 本番 healthcheck に R2 送信記録の鮮度監視（`MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN`）                       | 初回 FAIL（High 2）→ 修正 → 再レビュー PASS → Low 2 修正 |
| #91                   | `@fastify/static` 10.1.10（glob GHSA-3g3m-2fjr-6pw4 解消。Dependabot alert #1 は `fixed`）、制限台帳整合 | PASS（Low 1 修正）                                       |
| #92                   | 本番 `prod-release.sh` に exact-main CI ゲート（bypass なし）                                            | 初回 FAIL（Medium 1）→ 修正 → 再レビュー PASS            |
| #93                   | 他リポジトリ連携の実測評価（docs）                                                                       | Lead 確認                                                |

`ea3b943`（#94：文言・shellcheck 必須化・ADR 追記）は本番リリース後のマージで、本番には未反映（実行コードの差は release.sh のコメントとテストのみ）。

## 統合検証（Lead、#90+#91+#92 の結合ツリー）

typecheck・lint 成功、unit 721 件成功、integration 22 files / 749 件成功（`mirai_sf_test`）、build 成功、test:ops（本番ゲート 48/0）成功、secret-scan OK。各 PR は Required Checks（quality / e2e / docker）成功後に squash の自動マージ。main push CI run 41977905186（`07613ce`）は success。

## 本番リリースの実測

| 時刻 (JST) | 事象                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| 15:37:00   | `pnpm ops:prod:release 07613ce…` 開始。exact-main CI ゲートを通過                                                           |
| 15:37:26   | ビルド完了                                                                                                                  |
| 15:37:40   | 事前バックアップ `mirai_sf_prod-20261105T063727Z.dump`（137,422 bytes・28 テーブル）、R2 送信と読み戻し照合 OK（offsite=1） |
| 15:37:41   | migration `0016_list_created_index.sql` 適用（他は skip）。current 切替                                                     |
| 15:37:42   | healthz の commit 一致（試行 2 回目）。リリース完了 exit 0                                                                  |

## 技術受入（runbook §4 に対応）

| #    | 確認                                              | 結果                                                                                        |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | `GET /healthz`                                    | 200 / ok / db.ok / production                                                               |
| 2    | commit                                            | `07613cefba43b7e3b2dd732d0c616f61a1300c52`、current も同じ                                  |
| 3    | 公開 URL 未認証                                   | 302（Access）                                                                               |
| 4    | 未認証 `/api/auth/me`・メールヘッダ偽装・不正 JWT | すべて 401                                                                                  |
| 5・6 | 受付→別人承認→注文書、自己承認 ERR-105            | **未実施**（人間 OTP が必要）                                                               |
| 7    | バックアップ                                      | 事前バックアップ + R2 送信 OK                                                               |
| 8    | restore-drill                                     | 前回 2026-11-03 success。次回は日曜 04:30 の timer                                          |
| 9    | API journal                                       | 15:37 以降 5xx/ERROR 0 件                                                                   |
| 10   | rollback dry-run（→ `8a1ee99`）                   | 戻し先を表示、exit 0（DB は戻さない）                                                       |
| 追加 | 配信 `console.js` / `bridge.js`                   | 配信とディスクの SHA-256 一致                                                               |
| 追加 | DB                                                | schema 最大 `0016`（16 件）、`request_list_created_idx` 作成、request 0 件                  |
| 追加 | 監視                                              | 新 unit（オフサイト鮮度 90 分）を `~/.config/systemd/user` へ配置し実行 success、warnings 0 |

## 残課題（本書で解消したと主張しないもの）

1. 人間 OTP 後の別人 2 名による業務受入（ケース S / B）。
2. RPO 60 分の保証、全体 RTO、独立ホスト DR、月間可用性は未実証（監視の拡張は検知範囲の拡大のみ）。
3. 資格情報 rotation と user manager 環境の秘密除去、R2 保持規則、Access サービストークンは所有者判断待ち。
4. Sandbox の main 保護（他リポジトリ連携の次の一手、`docs/devline/repo-integration-status-20261105.md`）。
5. 本番の承認ゲートと成果物同一性（署名付き provenance）は未実装。

## ロールバック

`pnpm ops:prod:rollback 8a1ee9931e5838234a4f5da86f5e598f7d95100a`。DB は戻さない（0016 は index 追加のみで旧版と互換）。監視 unit は `/tmp/mirai-sf-prod-healthcheck.service.bak-20261105` に旧版を退避済み。

## 独立検証と追加対応（15:40〜15:50 JST）

- 本番の独立検証（staging-auditor、読取り専用）: PASS 11 / FAIL 0（`_work/production-verification-20261105.md`）。偽装ヘッダ・不正 JWT の拒否は journal 上も想定どおりの 3 件のみ。
- 本番 restore-drill を手動で 1 回実行（15:43〜15:44）: 事前バックアップ `…063727Z.dump` を一時DBへ復元し、件数・監査ハッシュ連鎖（9 件）照合 OK、一時DB削除。timer 初回は 11-08 04:30。
- 2026-11-03 のリハーサル用 API（`127.0.0.1:8786`・DB `mirai_sf_prodr`・environment=production 表示）が、systemd 管理外の過去エージェントセッションの子プロセスとして残っていたため、SIGTERM で停止した（ループバックのみで外部到達なし）。DB `mirai_sf_prodr` と `~/.local/share/mirai-sf-prodr` は削除していない。
- 本番 healthcheck の「origin/main と不一致」警告は、本番リリース後に docs/test のみの `ea3b943`（#94）がマージされたため（warning で失敗ではない）。
- R2 送信記録の無い dump 10 件は 2026-11-03 06:58Z〜08:16Z（オフサイト設定前）のもので、現行の監視は最新記録の鮮度のみを見る。
