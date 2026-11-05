# 他リポジトリ連携の実測評価と連携計画（2026-11-05）

状態: 評価のみ（**コード・設定・台帳は変更していない**。他リポジトリへの書込み・設定変更・ブランチ保護の変更もしていない）。
問い: 所有者「他のレポジトリとの連携はどうか」。前回の評価は `docs/devline/assessment/2026-11-04-cross-repo-status.md`、手順は `docs/devline/repo-onboarding.md`、契約案は `docs/devline/development-dispatcher-integration.md`。

## 1. 結論（3行）

1. **開発ラインの投入先として動くのは `Software-Factory-Sandbox` だけ**（台帳・設定・差分 policy すべてに載る唯一の repo）。repo-check は 8 項目中 7 PASS、FAIL は `required_checks`（main の保護が無い）の1件だけ。
2. **台帳に足せる新しい repo は今日の時点で無い**（4 repo とも全 PASS ではない。`ac-results` を出すのは Sandbox だけ）。Development-Dispatcher との契約連携は、相手の ADR-0009 が `Proposed` のままなので**実装しない判断を維持**する。
3. Staging の worker は稼働中（active・再起動 0 回）だが**直近 3 日は仕事が無く待機中**（最終の job 更新 2026-11-02 10:44 JST、Sandbox の最終 PR は 2026-11-03 の #11）。次の一手は**所有者が Sandbox の main を保護する**こと（SF 側の作業は不要）。

## 2. repo-check の実測（`pnpm ops:repo-check <repo> --json`、2026-11-05 14:08 JST）

`scripts/ops/repo-onboarding-check.mjs` v1.0.0。`gh api` の GET だけ。artifact の中身は読んでいない（`artifactContentsRead: false`）。4 repo とも総合判定 **FAIL（exit 1）**、UNKNOWN は 0 件。

| 検査              | Software-Factory-Sandbox                 | Development-Dispatcher           | dd-e2e-sandbox                   | AI-Company-Control-Center                              |
| ----------------- | ---------------------------------------- | -------------------------------- | -------------------------------- | ------------------------------------------------------ |
| `repository`      | PASS（id=1440860477）                    | PASS（id=1440366462）            | PASS（id=1440388690）            | PASS（id=1439497678）                                  |
| `private`         | PASS                                     | PASS                             | PASS                             | PASS                                                   |
| `archived`        | PASS                                     | PASS                             | PASS                             | PASS                                                   |
| `default_branch`  | PASS（main）                             | PASS（main）                     | PASS（main）                     | PASS（main）                                           |
| `required_checks` | **FAIL**（main が保護されていない）      | **FAIL**（同左）                 | **FAIL**（同左）                 | PASS（`api` `web` `secret-scan`。enforce_admins 有効） |
| `ci_workflow`     | PASS（ci.yml）                           | PASS（ci.yml）                   | PASS（ci.yml）                   | PASS（ci.yml）                                         |
| `latest_ci`       | PASS（run 41570309845・job 6/6 success） | PASS（run 41965866972・job 3/3） | PASS（run 41605619144・job 1/1） | PASS（run 41969820809・job 3/3）                       |
| `ac_results`      | PASS（同じ run に存在）                  | **FAIL**（無い）                 | **FAIL**（無い）                 | **FAIL**（無い）                                       |
| 計（PASS/FAIL）   | 7 / 1                                    | 6 / 2                            | 6 / 2                            | 7 / 1                                                  |

- 前回（2026-11-04）からの変化: Development-Dispatcher の `latest_ci` が FAIL（`api` job failure）→ **PASS** に回復。他は同じ。
- `ac_results` の PASS は「名前と存在」まで。v2 の一致性は実 runner が検証する（`repo-onboarding.md` 9章）。

## 3. 連携方式の整理

| repo                      | 連携方式                                    | SF での位置づけ（台帳・設定・policy）                               | 不足条件（だれが）                                                                                                                  | 推奨順    |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Software-Factory-Sandbox  | **開発ライン投入先**（稼働中）              | 台帳 ○・`DEVLINE_TARGET_REPOS`（preview）○・`SANDBOX_DIFF_POLICY` ○ | main の保護と必須チェック（`static` `build` `unit` `integration` `e2e` `security`）。**所有者**が Settings で設定                   | 1         |
| Development-Dispatcher    | **Dispatcher 契約**（SF → DD の REST 依頼） | 投入先にしない（役割が逆。DD は SF に仕事を投げる側／実行側）       | ADR-0009 の確定（現在 `Proposed`）、注文書 YAML → `job-request` v1 の写像、費用の円/USD 換算、main の保護（**相手と所有者**）       | 2         |
| AI-Company-Control-Center | **監視連携**（上位の制御・可視化）          | 投入先にしない（上位の制御）。SF の `src/` に参照 0 件              | 連携の契約自体が未定義（何を ACCC に送るか・受けるか）。保護は済み。`ac-results` は投入先でないので不要（**所有者**が範囲を決める） | 3         |
| dd-e2e-sandbox            | DD の E2E 用（SF の連携対象外）             | 投入先にしない                                                      | 投入先にするなら `ac-results` v2・`image`・main の保護・差分 policy がすべて要る。現時点で SF 側の理由が無い                        | 4（保留） |

- 推奨順の理由: 1 は SF 側の作業ゼロで全 PASS に届く（自動マージの前提 L-15 も満たせる）。2 は相手の契約が確定しないと書けない。3 は契約の定義から始まる。4 は SF にとっての用途が無い。

## 4. Staging の実ワーカーは Sandbox に対して動いているか

| 確認                                            | 結果（秘密は出していない）                                                                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `systemctl --user show mirai-sf-worker`         | `active (running)`、起動 2026-11-04 21:21:21 JST、`NRestarts=0`。`EnvironmentFile` は `preview.conf` と `release.env`                                                                   |
| `journalctl --user -u mirai-sf-worker`          | **該当行なし**。ユーザー journal の最古の行が 2026-11-05 01:27 JST で、起動時のログは回転済み。その後の出力も無い＝待機中（起動拒否・異常終了の記録も無い）                             |
| `preview.conf` のキー（有無だけ）               | `DEVLINE_WORKER_ENABLED`・`DEVLINE_TARGET_REPOS`（Sandbox の1件）・`DATABASE_URL` が設定済み                                                                                            |
| Staging DB の job（読取り専用トランザクション） | 3 件すべて Sandbox・`docker-claude`。`staged` 2 件（最終更新 2026-11-02 10:44 / 10:15 JST）、`stopped`（`budget_limit`）1 件（2026-11-01 19:49 JST）。実行中・lease 保持中の job は無い |
| Sandbox の直近 PR（GitHub GET）                 | #11（ac-results v2、2026-11-03 merged）、#10 / #8（AI 候補 REQ-2026-0012 / 0011、merged）。**#3（AI 候補 REQ-2026-0001、2026-10-31）が open のまま**                                    |
| Sandbox の直近 CI（GitHub GET）                 | 直近 7 run が `pull_request` で success（例外は 2026-11-01 の `auto/deployable-sample` の 1 run が failure、同じ PR の次の run で success）                                             |

- 判定: **経路は生きているが、現在は動かす仕事が無い**（最後の実走は 2026-11-02）。「今まさに Sandbox に向けて実行している」状態ではない。
- 残件: Sandbox の PR #3 は古い AI 候補（REQ-2026-0001 v1）。閉じるかどうかは人が判断する（`repo-onboarding.md` 5章の3。今回は触っていない）。

## 5. 台帳（`DEVLINE_REPO_LEDGER`）への追加の提案

- 条件（task-5）: repo-check が**全 PASS**、かつ差分 policy の定義が明確な場合だけ提案する。
- 結果: **提案なし**。全 PASS の repo は 0 件。差分 policy（`REPO_DIFF_POLICIES`）があるのは `Software-Factory` と Sandbox だけで、他の 3 repo には定義が無い。
- 台帳は 1 件（Sandbox）のまま。コードの変更はしていない。

## 6. 次の一手（所有者の判断が要るもの）

| #   | 作業                                                                                                                     | だれが       | SF 側の変更  |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------ | ------------ |
| 1   | Sandbox の main を保護し、必須チェックを CI の 6 job 名で指定（`docs/devline/assessment/branch-protection-proposal.md`） | 所有者       | 不要         |
| 2   | 1 の後に `pnpm ops:repo-check Kensan196948G/Software-Factory-Sandbox` を再実行し、全 PASS（exit 0）を記録                | 実行者       | docs のみ    |
| 3   | Sandbox の PR #3（古い AI 候補）を閉じるか判断                                                                           | 所有者       | 不要         |
| 4   | Development-Dispatcher の ADR-0009 が Accepted になったら、写像・冪等キー・費用換算を `api-contract.md` の粒度で決める   | 所有者・相手 | docs から    |
| 5   | ACCC と何を連携するか（SF の進捗・監査を送るか）の範囲を決める                                                           | 所有者       | 未定         |
| 6   | 2 つ目の**投入先**が要るなら、`ac-results` v2 を出す private repo を選ぶ（候補は 2026-11-04 の候補表）                   | 所有者       | 台帳＋policy |

## 7. 今回やっていないこと

- 他 repo への書込み（PR・issue・設定・ブランチ保護）、`DEVLINE_*` の設定変更、台帳・差分 policy のコード変更、unit の操作、DB への書込み（読取りは `default_transaction_read_only=on`）。
- トークンや設定ファイルの値の表示（キーの有無だけを見た）。

## 8. 再確認のしかた

```bash
for r in Software-Factory-Sandbox Development-Dispatcher dd-e2e-sandbox AI-Company-Control-Center; do
  pnpm ops:repo-check Kensan196948G/$r --json; echo "$r exit=$?"
done
systemctl --user show mirai-sf-worker -p ActiveState -p NRestarts -p ExecMainStartTimestamp
journalctl --user -u mirai-sf-worker --since -24h --no-pager | tail -20
gh api 'repos/Kensan196948G/Software-Factory-Sandbox/pulls?state=all&per_page=5' --jq '.[]|[.number,.state,.title]|@tsv'
```
