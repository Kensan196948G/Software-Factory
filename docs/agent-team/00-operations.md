# 自律 AI 開発チーム運用手順

本ドキュメントは `AGENTS.md` の詳細であり、記述が矛盾する場合は `AGENTS.md` を優先する。適用対象はこのリポジトリ（`Kensan196948G/Software-Factory`）のみである。

## 1. 目的と適用範囲

- 目的: AI エージェントチームが、調査・設計・実装・レビュー・PR 作成・マージ判定までを一貫して実行するための手順と境界を固定する。
- 適用範囲: このリポジトリでエージェントが行う開発作業すべて。ブランチ運用、コミット、PR、CI、マージ、停止条件、人間への承認要求を含む。
- 位置づけ: 本ドキュメントは `AGENTS.md` の詳細である。`AGENTS.md` と矛盾する場合は `AGENTS.md` が優先する。両者に無い判断が必要になった場合は、作業を止めて §7 の手順で人間に確認する。
- 対象外: 本番環境の配備、Cloudflare（Production・Tunnel・Access・DNS）の設定変更、課金・契約、認証・権限の重大変更、破壊的 DB 操作。これらは R4（§4）であり、人間の明示承認なしに実行しない。
- 作業場所: `main` の作業ツリーでは作業しない。`git worktree add -b auto/<slug> .agents/worktrees/auto/<slug> origin/main` で作った worktree 内で作業する。
- 前提: `main` への直接 push、force push、`--admin` マージ、保護ルールの回避は禁止する（`AGENTS.md` §2-4）。

## 2. 5 ロールの責務と独立性

| ロール       | 責務                                                                         | 成果物                                                                        | 禁止事項                                                           |
| ------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Orchestrator | タスク分解、状態遷移の管理、停止条件の判定、人間への判断要求、マージ実行     | タスク割当、状態遷移の記録、判断要求、マージ結果                              | 実装、レビュー、自分の判断の自己承認                               |
| Researcher   | 事実の収集と実測。既存仕様・保護設定・CI・スクリプトの確認。未確認事項の列挙 | 事実表、根拠（コマンドと出力）、未確認事項一覧                                | 設計判断、実装、未確認事項の断定                                   |
| Architect    | 設計、write scope と受入条件の定義、リスク分類、レビュー観点の指定           | 設計メモ、write scope、受入条件、R0〜R4 の分類                                | 実装、自分の設計の最終承認                                         |
| Builder      | 実装、検証の実行、commit、push、PR 作成、レビュー指摘の反映                  | ブランチ、commit、PR、検証ログ（コマンドと exit code）                        | 自分の PR の最終承認、マージ、write scope 外の変更、保護設定の変更 |
| Reviewer     | 実装者とは別コンテキストでの独立レビュー。重大度別の指摘                     | 指摘リスト（Critical / High / Medium / Low）、PASS / FAIL の根拠（file:line） | ファイルの変更（指摘のみ）、実装者と同じコンテキストでのレビュー   |

- 実装者とレビュアーは別コンテキストにする。Reviewer は Builder の会話を共有しない別セッションで起動する。
- このリポジトリの branch protection には `required_pull_request_reviews` が無いため、GitHub は承認数を強制しない（2026-11-09 JST 実測: 当該キーは存在しない）。したがって独立性は運用で担保する。
- 独立性を担保する運用は次の 3 点である。
  1. Reviewer は Builder の会話コンテキストを共有しない別セッションで実行する。
  2. Reviewer の指摘は PR コメントではなく、重大度と根拠（file:line）付きのタスク出力として残す。
  3. 指摘の反映は Builder が行い、Reviewer が再レビューして blocker が無いことを確認する。
- 承認数が保護設定で強制されない以上、「レビューした」という自己申告を根拠にマージしない。指摘リストと再レビューの記録を根拠にする。

## 3. タスク状態機械

状態は次の 17 個と、派生 4 個で構成する。

CREATED → QUEUED → PLANNING → RESEARCHING → DESIGNING → IMPLEMENTING → TESTING → REVIEWING → COMMITTING → PUSHING → PR_CREATED → CI_RUNNING → MERGE_READY → MERGING → MERGED → POST_MERGE_VERIFY → COMPLETED

派生状態: RETRYING / BLOCKED / APPROVAL_REQUIRED / FAILED

| 遷移                          | 条件                                                                                   | 実行コマンドの例                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| CREATED → QUEUED              | タスクが登録され、依存が満たされ `ready=true` になった                                 | `team_task_list` で `ready` を確認する                                                                         |
| QUEUED → PLANNING             | 担当がタスクを claim した                                                              | `team_task_update`（`task_id`、現在の `expected_revision`、`action=claim`）                                    |
| PLANNING → RESEARCHING        | 作業ブランチと作業場所を決めた                                                         | `git worktree add -b auto/<slug> .agents/worktrees/auto/<slug> origin/main`                                    |
| RESEARCHING → DESIGNING       | 事実の収集が終わり、既存仕様・保護設定・CI・受入条件を確認した                         | `gh api repos/Kensan196948G/Software-Factory/branches/main/protection`、`node scripts/ops/pr-ready.mjs --help` |
| DESIGNING → IMPLEMENTING      | write scope、受入条件、リスク分類（§4）を決めた                                        | なし（設計メモに記録する）                                                                                     |
| IMPLEMENTING → TESTING        | 編集が終わった                                                                         | `edit` / `write` で worktree 内を編集する                                                                      |
| TESTING → REVIEWING           | 実行可能な品質ゲート（§5）を実行し、未実行のゲートを「未実行」と記録した               | `pnpm exec prettier --check <files>`、`node scripts/secret-scan.mjs` など                                      |
| REVIEWING → COMMITTING        | 別コンテキストの Reviewer が blocker なしと判断した                                    | Reviewer の指摘リストを確認する                                                                                |
| COMMITTING → PUSHING          | Conventional Commits で commit した                                                    | `git add <files>` → `git commit -m "docs(agent-team): <要約>"`                                                 |
| PUSHING → PR_CREATED          | ブランチを push し、PR を作成した                                                      | `git push -u origin auto/<slug>` → `gh pr create --base main`                                                  |
| PR_CREATED → CI_RUNNING       | PR 作成により `pull_request` イベントが発火し、`quality` / `e2e` / `docker` が開始した | `gh pr checks <PR>`                                                                                            |
| CI_RUNNING → MERGE_READY      | 必須チェックが success し、`pr-ready` が exit 0 になった                               | `node scripts/ops/pr-ready.mjs <PR>`                                                                           |
| MERGE_READY → MERGING         | マージ条件（§6）をすべて満たした                                                       | `gh pr merge <PR> --squash --match-head-commit <head>`                                                         |
| MERGING → MERGED              | PR が merged になった                                                                  | `gh pr view <PR> --json state,mergedAt`                                                                        |
| MERGED → POST_MERGE_VERIFY    | `main` の push CI の結果を確認している                                                 | `gh run list --branch main --limit 5`                                                                          |
| POST_MERGE_VERIFY → COMPLETED | `main` の `quality` / `e2e` / `docker` が success し、証跡を記録した                   | `gh run view <run-id>` → `team_task_update`（`action=complete`）                                               |

派生状態の遷移条件は次のとおりである。

- RETRYING: 一時的な失敗で、時間をおくか再実行すれば回復し得る状態。同一原因の再実行は 3 回まで（§8）。CI の `cancelled` / `stale` は「後続実行に置換された可能性」があるため RETRYING ではなく未確認として待機する。
- BLOCKED: 依存タスク、未解決レビュースレッド、保護条件、競合などで前進できない状態。誰が何をすれば解除できるかを記録し、解除条件が満たされたら直前の状態に戻す。
- APPROVAL_REQUIRED: R4（§4）の操作が必要になった状態。§7 の数字選択式で人間に承認を求め、承認が得られるまで対象操作を実行しない。回答が無い場合は R4 を実行しない。
- FAILED: 修復不能、または §8 の上限に到達した状態。証跡を残して人間にエスカレーションする。人間の指示があるまで再開しない。

`node scripts/ops/pr-ready.mjs` の exit 75 は「未確認（待てば変わる）」であり、作業の失敗でも RETRYING でもない。**exit 75 を RETRYING として扱わない。** 状態を進めず、待ってから同じコマンドを再実行する。

Exit code の扱いは次のとおりである。

- 0: 条件を満たした。次の状態へ進む。
- 75: 未確認。待機して再実行する。状態は変えない。
- 1: 失敗または照会不能。原因を特定して対処する。同じコマンドの再実行だけを繰り返さない（§8）。

## 4. リスク分類 R0〜R4

| 区分             | 定義                                         | 例                                                                                                                                                                                                 | 手続き                                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0 観測          | 読み取りのみで、リポジトリ・環境を変更しない | `gh api` の GET、`git log` / `git status`、`node scripts/ops/pr-ready.mjs`、`docs/` の閲覧                                                                                                         | 制限なし。証跡を残す                                                                                                                                                                                                                                                             |
| R1 ローカル可逆  | ローカルで完結し、破棄できる変更             | worktree 内のファイル作成・編集、ローカル commit、`pnpm exec prettier --write`、ローカル検証                                                                                                       | Builder が実行できる                                                                                                                                                                                                                                                             |
| R2 遠隔・可逆    | リモートに影響するが、取り消せる変更         | `auto/<slug>` への push、PR 作成、PR コメント、head を更新して `pull_request` イベントを起こすこと                                                                                                 | Builder が実行できる。`main` への push は不可                                                                                                                                                                                                                                    |
| R3 統合（merge） | `main` への squash merge                     | 本ドキュメントの PR のマージ                                                                                                                                                                       | §6 の条件を満たし、Reviewer の blocker が無いときに限り実行できる。**マージ後、main の push CI（quality / e2e / docker）が success した後の最初の timer 実行で staging へ自動配備される。実測の main CI は約 21〜25 分、timer は 10 分間隔のため、配備まで通常 20〜35 分かかる** |
| R4 承認必須      | 不可逆、または本番・権限・課金に影響する操作 | 本番配備、rollback、Cloudflare の変更、課金・契約、認証・権限の変更、破壊的 DB 操作、`.github/workflows/**` と `deploy/**` の変更、secret rotation、force push、`--admin` マージ、`main` 直接 push | 人間の明示承認（§7）が必要。承認が無ければ実行しない                                                                                                                                                                                                                             |

- R3 の merge は「コードを `main` に統合する」操作であると同時に「staging を更新する」操作でもある。staging の自動追従は `deploy/systemd/mirai-sf-autofollow.timer` が 10 分間隔で行う。配備は main の push CI（quality / e2e / docker）が success した後になるため、マージから配備まで通常 20〜35 分かかる。
- R4 に該当するか迷う場合は R4 として扱い、人間に確認する。過剰な承認要求は事故より安い。

## 5. 品質ゲート Gate01〜10

| Gate   | 内容            | コマンドまたはチェック名             | 備考                                                                                                                                                                 |
| ------ | --------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate01 | 型検査          | `pnpm typecheck`                     | ローカルは 3 プロジェクト（`tsconfig.json` / `tsconfig.api.json` / `tsconfig.ops.json`）。CI の typecheck は 2 プロジェクト（`tsconfig.json` / `tsconfig.api.json`） |
| Gate02 | Lint            | `pnpm lint`                          | `eslint . --max-warnings=0`                                                                                                                                          |
| Gate03 | テスト          | `pnpm test`                          | unit + integration（`mirai_sf_test` を使用）                                                                                                                         |
| Gate04 | ビルド          | `pnpm build`                         | API と Web の両方                                                                                                                                                    |
| Gate05 | DB 検証         | `pnpm db:verify`                     | PostgreSQL が必要                                                                                                                                                    |
| Gate06 | secret スキャン | `node scripts/secret-scan.mjs`       | CI の `quality` でも実行される                                                                                                                                       |
| Gate07 | CI `quality`    | チェック名 `quality`                 | 20 分 timeout。audit / typecheck / lint / unit / migration 2 回 / seed / db verify / integration / build / secret scan                                               |
| Gate08 | CI `e2e`        | チェック名 `e2e`                     | `quality` に依存。Playwright                                                                                                                                         |
| Gate09 | CI `docker`     | チェック名 `docker`                  | `quality` に依存。Docker イメージのビルドと隔離試験                                                                                                                  |
| Gate10 | マージ前ゲート  | `node scripts/ops/pr-ready.mjs <PR>` | exit 0 でマージ可。exit 75 は未確認、exit 1 は失敗・照会不能                                                                                                         |

- CI に無い検証が 2 つある。`prettier`（`pnpm exec prettier --check ...`）と `pnpm test:ops`（`scripts/ops/tests/*.sh`）は `.github/workflows/ci.yml` にステップが無い。変更内容に応じてローカルで実行し、実行できない場合は「未実行」と記録する。
- 実行できないゲートは「未実行」と記録し、CI に委ねる。ローカルに PostgreSQL や Docker が無い場合、Gate05 / Gate09 は未実行となり得る。CI の `quality` が Gate01〜05 と Gate06 の相当を実行し、`e2e` と `docker` がそれぞれ Gate08 / Gate09 を実行する。
- CI の実測所要時間は PR #137（2026-11-08 JST。run は 2026-11-07T21:34Z 開始）で `quality` 10 分 12 秒、`e2e` 14 分 5 秒、`docker` 1 分 10 秒である。CI の完了を待つ間は他の作業を進め、ポーリングだけを繰り返さない。

## 6. マージ条件と停止条件

マージの必須条件は次のとおりである。

- 必須チェック `quality` / `e2e` / `docker` が success である（app_id 15368）。
- 未解決のレビュースレッドが 0 件である（`required_conversation_resolution=true`）。
- PR が draft でない。
- `mergeStateStatus` が `CLEAN`、または `strict=false` のため `BEHIND` である（`DIRTY` / `DRAFT` は不可、`UNKNOWN` は待機）。
- `reviewDecision` が `CHANGES_REQUESTED` / `REVIEW_REQUIRED` でない。`required_pull_request_reviews` が無いため通常は null だが、人間がレビューを要求した場合は該当し得る。
- Reviewer の blocker（Critical / High）が無い。

マージ手順は次のとおりである。

1. `node scripts/ops/pr-ready.mjs <PR>` を実行し、exit 0 を確認する。
2. 出力から `head=<40 桁 SHA>` を控える。
3. `gh pr merge <PR> --squash --match-head-commit <head>` を実行する。
4. `gh pr view <PR> --json state,mergedAt` で `state=MERGED` を確認する。

- `--admin` / `--auto` / force push / `-b` / `-t` は使わない。`--match-head-commit` は、レビューした内容とマージ対象が同一であることを保証するために必須とする。
- マージは Orchestrator（Lead）が実行する。Builder はマージしない。

停止条件は次のとおりである。

- `pr-ready` が exit 1: 失敗または照会不能。原因を特定するまでマージしない。同じ失敗を再実行だけで繰り返さない。
- `pr-ready` が exit 75: 未確認（待てば変わる）。状態を進めず、待って再実行する。RETRYING として扱わない。
- 保護設定が読めない: `--checks` で回避しない。`--checks` 指定時は保護設定を読まないため、未解決スレッド・BEHIND 以外は保護条件未確認のまま exit 0 を返し得る。exit 0 でもマージしない（fail-closed）。
- 必須チェックが `skipped`: exit 1 として扱う。skip を成功として扱わない。
- `mergeStateStatus` が `DIRTY` / `DRAFT`、または strict=true の環境で `BEHIND`: マージしない。
- `reviewDecision` が `CHANGES_REQUESTED` / `REVIEW_REQUIRED`: マージしない。
- 未解決スレッドが 1 件以上: 解決するまでマージしない。
- R4 の操作が必要になった: APPROVAL_REQUIRED に移し、§7 で承認を求める。

## 7. 人間判断プロトコル

- 人間への確認は数字選択式のみで行う。自由記述の長文回答を求めない。
- 1 回の確認で扱う論点は 1 つにする。
- 選択肢は 2〜5 個にする。
- 推奨を明示する。
- 回答が無ければ R4 を実行しない。デフォルトは「何もしない」であり、安全側に倒す。
- 回答は数字で受け取り、追加の確認は必要最小限（1 問）にとどめる。
- 承認の記録（何を・いつ・誰が承認したか）を残す。記録が無い承認は無いものとして扱う。
- **品質門禁の承認は所有者本人のみが行う。** 品質門禁（要件レビュー・テストケースレビュー・リリース・結項）の承認は所有者本人のみが行い、エージェントおよび他の担当者は承認しない。承認記録（日時・対象・承認者）を残し、記録が無い承認は無いものとして扱う。

例:

1. 承認する（推奨）
2. 条件付きで承認する（条件を数字の後に続けて書く）
3. 却下する

## 8. 反復と自己修復の上限

| 項目                         | 上限    | 上限到達時の動作                                              |
| ---------------------------- | ------- | ------------------------------------------------------------- |
| 同一原因の失敗               | 3 回    | 戦略を変える。原因分析をやり直し、別のアプローチを選ぶ        |
| 通信エラー                   | 3 回    | 待機して再試行し、回復しなければ BLOCKED として人間に報告する |
| 再割当（担当・ロールの変更） | 2 回    | 再割当をやめ、Orchestrator が人間にエスカレーションする       |
| Ralph ループ                 | 8 Round | ループを止め、証跡を整理して人間に報告する                    |
| 進展なし                     | 3 Round | 戦略を変更する                                                |

- 上限はリセットしない。同じ原因による失敗は、成功したかどうかに関わらず累積で数える。
- この上限は行動規範であり、ツールが強制するものではない。エージェントが自分で数え、上限に達したら自分で止まる。
- 上限に達した状態で同じ操作を続けない。続ける場合は、人間の明示的な指示を必要とする。

## 9. 証跡と報告

- 報告は「実行済み」「未実行」「失敗」の 3 区分で行う。成功したものだけを並べない。
- 実行済みの検証は、コマンド・exit code・時刻を 1 組で残す。例: `node scripts/secret-scan.mjs` exit 0（2026-11-09 05:50 JST）。
- パイプ越しに exit code を読まない。`cmd | tee log` の終了コードは `tee` のものであり、`cmd` のものではない。`set -o pipefail` を使うか、出力をファイルに落として `$?` を読む。
- secret・接続文字列・実メールアドレス・個人情報を証跡に残さない。CI のテスト用固定値も、値そのものを書かない。
- 同じ失敗を再実行だけで繰り返さない。再実行する場合は、原因の仮説と確認方法を先に決める。
- PR 本文の「テスト結果」には、実行した検証と exit code、未実行の検証を分けて書く。「CI結果」は結果が返るまで「起票後に実行」と書き、結果を先取りして書かない。
- 時刻は計測したタイムゾーンを明記する。

## 10. 既知の制約と未確認事項

既知の制約は次のとおりである。

- `.github/workflows/**` はエージェントが変更できない（R4）。CI の変更は人間が `scripts/apply-ci.sh` で適用する。
- 本番は所有者承認で実行する運用だが、`scripts/ops/prod-release.sh` に承認プロンプト・承認変数は無い。コード上のゲートは exact-main CI ゲートのみ（`MIRAI_SF_RELEASE_CI_GATE=1` を強制）であり、人間の承認は会話・記録側で担保する。`docs/production/24-production-deploy-runbook.md` の前提表では所有者の配備承認は「未取得」である。
- staging は `deploy/systemd/mirai-sf-autofollow.timer` が 10 分間隔で `origin/main` に追従する。exact-main CI ゲート（`quality` / `e2e` / `docker` の success）を通った場合のみ配備する。exit 75 は `SuccessExitStatus=75` により成功扱いであり、次回の実行で再確認する。本番用の autofollow は無い。
- Required Checks は branch protection で強制済みである（実測: `required_status_checks.strict=false`、required checks は `quality` / `e2e` / `docker`（app_id 15368）、`enforce_admins=true`、`allow_force_pushes=false`、`allow_deletions=false`、`required_conversation_resolution=true`）。
- リポジトリ設定は squash のみ（`allow_merge_commit=false`、`allow_rebase_merge=false`、`allow_squash_merge=true`）、`delete_branch_on_merge=true`、`squash_merge_commit_title=PR_TITLE`、`squash_merge_commit_message=BLANK`、rulesets は 0 件である。
- skip 指示子を commit message / PR タイトル / PR 本文のいずれかに入れると、workflow run 自体が生成されず必須チェックが付かない。squash 本文に混入した事故は `docs/production/22-batch2-plan-20261106.md` §9-3 に記録されている。

未確認事項と現在値は次のとおりである（現在値の正本は `docs/production/26-release-status.md`）。

- 本番の現在 SHA: `2d0766b0`（2026-11-09 07:51 JST 実測）。
- 最新 main（`e9d09787`）の配備承認: 未取得（`docs/production/26` §3、`docs/production/24` の前提表）。
- Dependabot の open PR の採否は未確認である（2026-11-09 JST 時点で #133〜#137 の 5 件が open）。
