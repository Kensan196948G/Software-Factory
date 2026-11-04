# 2つ目の投入先の候補一覧（2026-11-04 実測）

対象: 所有者のアカウント `Kensan196948G` のリポジトリ。開発ライン（`docs/devline/repo-onboarding.md`）の投入先にできるかの**材料**。
実施: 開発ライン（オンボーディング）担当。**読取りのみ**（`gh` の GET だけ。clone・書込み・PR 作成・設定変更・配備・DB・Cloudflare は触っていない）。

**投入先にできるのは private のリポジトリだけ**（`docs/limitations.md` L-14。公開リポジトリを受ける例外は作らない）。この表の public は**候補ではない**（比較のため実測値を残す）。

## 1. 方法（実測のコマンド）

```bash
gh repo list Kensan196948G --limit 100 --json name,visibility,updatedAt,isArchived
gh api repos/Kensan196948G/<name>/actions/workflows?per_page=100        # ci.yml の有無
gh api repos/Kensan196948G/<name>/actions/artifacts?per_page=100        # ac-results の有無（名前だけ）
gh api repos/Kensan196948G/<name>/branches/<default>/protection        # required_status_checks
```

- `--limit 100` に対して **67 件**が返った（打ち切りなし＝全件）。
- 秘密情報は見ていない・出していない。artifact の**中身は落としていない**（`ac-results` は名前と存在だけ。v2 形式かどうかは未判定）。
- 1回の検査で前提をまとめて確かめるには `pnpm ops:repo-check <owner/name>`（`scripts/ops/repo-onboarding-check.mjs`）。この表と同じ項目を PASS / FAIL / UNKNOWN で返す。

## 2. 全体（2026-11-04 実測）

| 区分                        | 件数 | 備考                                                      |
| --------------------------- | ---- | --------------------------------------------------------- |
| リポジトリ総数              | 67   | `gh repo list --limit 100`                                |
| private（投入先になり得る） | 33   | 下の表                                                    |
| public（**対象外**）        | 34   | L-14 により不可。下の表に名前だけ残す                     |
| archived                    | 1    | `CivilTiwn-3D`（private。読取り専用なので投入先にしない） |

private 33 件のうち:

| 検査                                  | 実測                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml` がある     | **31 / 33**（無い: `Civil-IT-Operation-Enterprised-Platform`、`ClaudeCode-System-Development-Documents`） |
| 既定ブランチに required_status_checks | **8 / 33**                                                                                                |
| 保護はあるが必須チェックが無い        | **25 / 33**                                                                                               |
| artifact `ac-results` がある          | **1 / 33**（`Software-Factory-Sandbox` のみ）                                                             |

## 3. private の比較表（投入先の候補。33件）

「最終更新」は `gh repo list` の `updatedAt`（UTC の日付）。push 日時ではない。`ci.yml` は workflow 一覧で `.github/workflows/ci.yml` が active か。`ac-results` は artifact の**名前と存在**だけ。

| リポジトリ                                | 可視性  | 最終更新   | archived | ci.yml | ac-results | 必須チェック（required_status_checks）                                       |
| ----------------------------------------- | ------- | ---------- | -------- | ------ | ---------- | ---------------------------------------------------------------------------- |
| `Software-Factory`                        | private | 2026-11-04 | なし     | 有     | 無         | quality, e2e, docker                                                         |
| `RIHRP-Research-Studio`                   | private | 2026-11-03 | なし     | 有     | 無         | API (ruff / pytest), Web (tsc / vitest / build), Secret scan (gitleaks)      |
| `AI-Company-Control-Center`               | private | 2026-11-03 | なし     | 有     | 無         | api, web, secret-scan                                                        |
| `dd-e2e-sandbox`                          | private | 2026-11-03 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `Development-Dispatcher`                  | private | 2026-11-03 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `Software-Factory-Sandbox`                | private | 2026-11-03 | なし     | 有     | **有**     | 保護あり・必須なし                                                           |
| `Remote-Service-Platform-for-Linux`       | private | 2026-11-02 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `Mirai-Info`                              | private | 2026-11-01 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `Deep-Seek-Harness-Project`               | private | 2026-10-28 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `OpenCode-Harness`                        | private | 2026-10-24 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `DX-Project-Portfolio-Atlas`              | private | 2026-10-24 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `PC_Optimizer`                            | private | 2026-09-30 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `Civil-IT-Operation-Enterprised-Platform` | private | 2026-09-30 | なし     | **無** | 無         | verify                                                                       |
| `MIRAI_Site_Carbon_Navigator`             | private | 2026-09-30 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `Mirai-Construction-AI-Platform`          | private | 2026-09-30 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `Design-Education-AI-Grading-MVP`         | private | 2026-09-30 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `Construction-Logistics-Route-Planner`    | private | 2026-09-30 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `Civil-4D-AI-Planner`                     | private | 2026-09-30 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `AI-CTO-Knowledge-Base`                   | private | 2026-09-30 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `PC-Ops-Orchestrator`                     | private | 2026-09-27 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `AI-Structural-Engineering-Platform`      | private | 2026-09-18 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `ActiveDirectory-Entry-Tools`             | private | 2026-09-18 | なし     | 有     | 無         | Backend (Python), Frontend (Node.js), Security scan, E2E (Playwright)        |
| `CMDB-DocKit`                             | private | 2026-09-18 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `Mirai-Sales-Pipeline`                    | private | 2026-09-06 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `Mirai-Site-Admin-Workflow`               | private | 2026-09-06 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `Mirai-Executive-Cockpit`                 | private | 2026-09-06 | なし     | 有     | 無         | API (lint / typecheck / test / build), Web (lint / typecheck / test / build) |
| `Mirai-Audit-Workpaper`                   | private | 2026-08-27 | なし     | 有     | 無         | app, docs, secretscan                                                        |
| `Windows-Deploy-Management-System`        | private | 2026-08-19 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `Remote-Service-Platform`                 | private | 2026-08-15 | なし     | 有     | 無         | 保護あり・必須なし                                                           |
| `CivilPDF-Editor`                         | private | 2026-08-13 | なし     | 有     | 無         | Lint / Typecheck / Test / Build, E2E (Playwright Chromium)                   |
| `CivilTiwn-3D`                            | private | 2026-08-11 | **あり** | 有     | 無         | 保護あり・必須なし                                                           |
| `ClaudeCode-System-Development-Documents` | private | 2026-07-11 | なし     | **無** | 無         | 保護あり・必須なし                                                           |
| `Codex-StartUpTools-New-Windows`          | private | 2026-06-07 | なし     | 有     | 無         | 保護あり・必須なし                                                           |

## 4. public の一覧（**投入先にできない**。34件）

L-14 により、公開リポジトリは常に ERR-405（例外設定なし）。記録のため名前と最終更新だけ残す。

| リポジトリ                                   | 可視性 | 最終更新   | archived |
| -------------------------------------------- | ------ | ---------- | -------- |
| `AI-HelpDesk-Platform`                       | public | 2026-11-04 | なし     |
| `SiteLive-Twin`                              | public | 2026-10-21 | なし     |
| `3D-Portal-Google3D`                         | public | 2026-10-20 | なし     |
| `Civil-Cost-Index-Dashboard`                 | public | 2026-10-18 | なし     |
| `Public-Infrastructure-Maintenance-Map`      | public | 2026-10-12 | なし     |
| `Claude-StartUpTools-New-Linux`              | public | 2026-10-10 | なし     |
| `Construction-Public-Twin-Portal`            | public | 2026-10-04 | なし     |
| `International-Civil-Research-Patent-Scout`  | public | 2026-10-01 | なし     |
| `ClaudeCode-StartUpTools-New`                | public | 2026-10-01 | なし     |
| `Claude-StartUpTools-New-Windows`            | public | 2026-09-30 | なし     |
| `Civil-Terrain-Slope-Risk-Viewer`            | public | 2026-09-30 | なし     |
| `Construction-Enterprise-Operating-Platform` | public | 2026-09-30 | なし     |
| `Mirai-AI-Agent-Business-Platform`           | public | 2026-09-30 | なし     |
| `Tokyo-Metro-3D-Operation-Visualizer`        | public | 2026-09-30 | なし     |
| `Mirai-Board-Audit-Governance`               | public | 2026-09-30 | なし     |
| `Global-Civil-API-Catalog`                   | public | 2026-09-30 | なし     |
| `ITSM-Management`                            | public | 2026-09-30 | なし     |
| `Hermes-Agent-OS-Startup-Tools-Linux`        | public | 2026-09-30 | なし     |
| `Codex-StartUpTools-New-Linux`               | public | 2026-09-30 | なし     |
| `wmcdss`                                     | public | 2026-09-29 | なし     |
| `open-design`                                | public | 2026-09-25 | なし     |
| `Civil-Technology-IP-Intelligence-Platform`  | public | 2026-09-10 | なし     |
| `Construction-DX-Idea`                       | public | 2026-09-06 | なし     |
| `Construction-LegalOps-DX`                   | public | 2026-09-06 | なし     |
| `Open-BIM-Information-Platform`              | public | 2026-09-06 | なし     |
| `enterprise-knowledge-cycle-platform`        | public | 2026-09-01 | なし     |
| `Public-Works-Stakeholder-Map`               | public | 2026-08-31 | なし     |
| `Server-Disk-Management`                     | public | 2026-08-27 | なし     |
| `Open-BIM-CIM-Dictionary-Assistant`          | public | 2026-08-21 | なし     |
| `Civil-Weather-Water-Decision`               | public | 2026-08-21 | なし     |
| `CivilDraft-Web-CAD`                         | public | 2026-08-21 | なし     |
| `BLB-Safe-Renamer`                           | public | 2026-07-02 | なし     |
| `Ubuntu-Operations-Control-Console`          | public | 2026-06-29 | なし     |
| `Codex-StartUpTools`                         | public | 2026-06-02 | なし     |

## 5. 実測からの判定（この表をどう読むか）

1. **今すぐ前提を全部満たす repo は無い。** `ac-results` があるのは `Software-Factory-Sandbox` だけで、同 repo も必須チェックが無い（保護はあるが required_status_checks が空）。`pnpm ops:repo-check Kensan196948G/Software-Factory-Sandbox` の実測は PASS 7 / FAIL 1、総合 FAIL（exit 1）。
2. **2つ目の投入先にするには、相手 repo 側の作業が要る。** 必須チェックの設定と、`ci.yml` で `ac-results`（と配備するなら `image`）を同じ run に出すこと。SF は相手の CI を代わりに作らない（`docs/devline/repo-onboarding.md` 7章・10章）。
3. **`Software-Factory` 自身は投入先ではない。** この repo は工場（SF）であって、注文書を流す先ではない（`ac-results` も出していない）。
4. **役割が逆・上位の repo は候補にしない。** `Development-Dispatcher`（SF に仕事を投げる相手）・`AI-Company-Control-Center`（相手の上位）・`dd-e2e-sandbox`（相手の E2E 用）は、SF の投入先にすると役割が循環する。
5. 上の 1〜4 は**推定ではなく**、1 の実測出力と 3〜4 の文書（`docs/devline/development-dispatcher-integration.md`・`2026-11-04-cross-repo-status.md`）に基づく。

## 6. 再確認のしかた（次回）

```bash
gh repo list Kensan196948G --limit 100 --json name,visibility,updatedAt,isArchived
pnpm ops:repo-check Kensan196948G/<name>          # 前提の一括検査（読取りのみ）
pnpm ops:repo-check Kensan196948G/<name> --json    # 機械可読
```

値が変わっている可能性があるため、この表を根拠に台帳・設定を変える前に、必ず `<name>` を指定して再検査する（表は 2026-11-04 時点の実測）。
