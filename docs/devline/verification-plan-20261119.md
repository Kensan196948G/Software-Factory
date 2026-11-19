# 実 runner / 実 Docker 配備 / 実 AI の検証計画（2026-11-19）

作成: 2026-11-19 12:20 JST。対象: `5700fa76`（Staging `fd0bc8fe` は docs のみ差）。状態: **計画**（実施の可否・範囲は所有者の判断）。時刻はすべて JST。

## 1. なぜ今か

レポート v7 の条件③「実 runner / 実 Docker 配備 / 実 AI 実行の扱いの確定」。実 runner の通し実走は **2026-11-01〜02**（`docs/devline/real-runner.md` §16、Sandbox 2 件）が最後で、その後に **DEVLINE_ALLOW_PRODUCTION（#191）・F-1/F-2（#195）・C1/C2（#196）・F-3（#197）** が入っている。実走の再確認と、未検証項目の受容判断が必要。

## 2. 前提（既存の実装・実測）

| 項目           | 値                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| runner         | `DEVLINE_RUNNER_KIND=docker-claude`。既定は fake。Staging は `APP_ENV=staging` で起動可                          |
| 接続先         | private repo `Kensan196948G/Software-Factory-Sandbox`（許可台帳と `DEVLINE_TARGET_REPOS` の積集合）              |
| 資格情報       | `~/.config/mirai-sf/devline-secrets.env`（0600）: 専用 `DEVLINE_GITHUB_TOKEN` と `ANTHROPIC_API_KEY`            |
| 費用           | 1 タスク 1,000 円（`DEVLINE_BUDGET_JPY` ≤ 1000）。超えたら停止                                                  |
| 隔離           | 専用ネットワーク（外へ出られない実測あり）、作業ツリーのみ bind mount、gitdir は外、advisory lock で 1 台      |
| 自動マージ     | `DEVLINE_AUTO_MERGE=1` で有効。既定 0。C1 修正で**青の注文書だけ**が対象（黄は `order_signal_not_blue`、赤は不可） |
| 本番           | `DEVLINE_ALLOW_PRODUCTION=1` を所有者が明示したときだけ本番でも起動可（既定は拒否）                              |
| 画像           | `msf-devline-runner:2.1.316` / `msf-devline-egress-proxy:v1`（`deploy/devline/`）                                |

## 3. 検証項目

### A. 実 Docker 隔離（実配備の前提）

- `pnpm test:docker` が成功すること（実 Docker の隔離試験。外部へは送らない）。
- runner コンテナの中から `1.1.1.1:443` / GitHub の IP へ接続できないこと（`ENETUNREACH` / `EAI_AGAIN`）。§16 と同じ確認。

### B. 実 AI 実行の通し（本命）

`docs/devline/real-runner.md` §7 の手順で、Sandbox に作り物の注文書 1 件を投入する。

1. `docker build` で画像を用意し、`pnpm test:docker` を通す。
2. 検証用 DB（`mirai_sf_devline`）で migrate（**Staging の DB は使わない**）。
3. `devline-secrets.env` を 0600 で用意（値は画面・履歴に出さない）。
4. dry-run（`scripts/devline-real-run.ts`、送信なし）。
5. `--confirm-real-run` で 1 件実行し、`pr_ready` まで通す。
6. 人の承認で merge → 配備（Staging）→ smoke → 戻し。**承認・merge・配備・戻しは所有者が画面で行う**（AI は代行しない）。
7. 後片付け: コンテナ（ラベル `msf.devline=1`）を kill、Sandbox の PR を close してブランチを削除、資格情報を失効。

受入基準: 各段階の記録（`job_event` / `verification` / AC artifact / `release`）、費用 ≤1,000 円、PR の head と merge の tree 一致、配備の version 一致・health/smoke 合格、戻しの成功、監査に主要操作が残る。

### C. 自動マージ（C1）の実走 — 任意

- Staging で `DEVLINE_AUTO_MERGE=1` を一時設定し、**青**の注文書で自動マージが成立すること、**黄**は `order_signal_not_blue` で拒否され job が `pr_ready` のまま残ること、監査に `job.auto_merge`（送信/拒否）が残ることを実測する。
- 実施後は `DEVLINE_AUTO_MERGE` を戻す（既定 0）。

### D. 未検証領域の扱い — 任意（別判断）

- 実 AI の**修正やり直し**（CI 失敗 → revising）、**予算到達の停止**、**禁止差分・prompt injection** への動作。§16 の 2 件は修正 0 回で、この 3 つは未確認のまま。
- 費用と Anthropic Console の請求の照合。
- 配備後の smoke は `/length` だけで、依頼で作った機能の動作は CI と手元確認のみ。

## 4. 実施しないこと（既定）

- **本番での実 runner / 自動マージ**（`DEVLINE_ALLOW_PRODUCTION=1` の本番設定）。実施する場合は所有者の明示承認に加え、本番 DB・Sandbox・費用の影響評価を別途行う。
- 実テナント・実顧客データ・実在のリポジトリ（Sandbox 以外）への投入。

## 5. リスクと戻し

| リスク                                 | 対策                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| Docker のアドレスプール枯渇（未確定）  | 既存の他プロジェクトのネットワークを増やさない。失敗時は段階・stderr・ブリッジ数を記録 |
| AI の誤実装が Sandbox に入る           | 専用リポジトリ・作り物のみ。PR は人が merge するまで取り込まない                       |
| 費用が上限に達する                     | `DEVLINE_BUDGET_JPY=1000`。到達で停止し再開不可（記録は残す）                          |
| 資格情報の露出                         | `devline-secrets.env` は 0600・リポジトリ外。終了後にキーとトークンを失効              |
| 失敗時に環境が残る                     | ラベル `msf.devline=1` のコンテナを kill、advisory lock の解放を確認                    |

## 6. 決定事項（所有者）

- 実施範囲: A+B（推奨）／A+B+C／A+B+C+D／計画のみ。
- 実施環境: Staging（推奨）／本番（`DEVLINE_ALLOW_PRODUCTION=1`、別承認）。
- 費用上限: 1,000 円/タスク（既定）でよいか。
- 実施時期: いま／後日。
