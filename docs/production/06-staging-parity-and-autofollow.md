# Staging の main 自動追従と Staging/本番の状態（実測）

対象: Staging（`127.0.0.1:8782` / `mirai-sf-api.service`）と本番（`127.0.0.1:8783` / `mirai-sf-prod-api.service`）。
目的: (1) 2026-11-04 時点の健全性を**読み取りのみ**で実測して証跡を残す、(2) main が進んだら Staging が自動で
追従し、失敗時は旧版を維持する仕組みを用意する。

> 本作業（#78 のPR時点）ではサービス再起動・配備・設定変更・Cloudflare 操作・DB 書込みをしていない。
> 自動追従の **timer は 2026-11-04 15:29 JST にインストール・有効化済み**（§4-1 に実施記録）。§1 の実測値は PR 作成時点のものである。

## 1. 実測値（2026-11-04 14:36〜14:37 JST）

測定方法: `curl -sS`（8782 / 8783 の `/healthz`）、`systemctl --user list-units / show / list-timers`、
`ls -l`（dump の mtime）、`readlink`（`current`）。**`git fetch` は実行していない**ため、下の `origin/main` は
最後に取得した ref の値。

### 1-1. 稼働状態

| 項目                      | Staging                                                               | 本番                                                                  |
| ------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `/healthz` の URL         | `http://127.0.0.1:8782/healthz`                                       | `http://127.0.0.1:8783/healthz`                                       |
| `status`                  | `ok`                                                                  | `ok`                                                                  |
| `environment`             | `staging`                                                             | `production`                                                          |
| `commit`                  | `aeeddd985de2ba8ccc16bcdb508480c481f571b6`                            | `26397fd7a25bd65832073e461acff5a403c6b8d3`                            |
| `db.ok`                   | `true`（5.6 ms）                                                      | `true`（5.5 ms）                                                      |
| `current`（シンボリック） | `releases/aeeddd985de2ba8ccc16bcdb508480c481f571b6`（healthz と一致） | `releases/26397fd7a25bd65832073e461acff5a403c6b8d3`（healthz と一致） |
| API ユニット              | `mirai-sf-api.service` / active / `NRestarts=0`                       | `mirai-sf-prod-api.service` / active / `NRestarts=0`                  |
| worker                    | `mirai-sf-worker.service` active                                      | なし（ADR §8-10 で本番は動かさない）                                  |

`systemctl --user list-units 'mirai-sf*' --all` の結果は 19 unit（8 service + timer 等）。
`mirai-sf-api.service` / `mirai-sf-prod-api.service` はどちらも `ActiveState=active`、`NRestarts=0`（14:37:00 JST）。

### 1-2. 定期ジョブの結果（`systemctl --user show -p Result -p ExecMainStatus -p ExecMainExitTimestamp`）

| unit                                  | Result  | ExecMainStatus | 最終実行（JST）     |
| ------------------------------------- | ------- | -------------- | ------------------- |
| `mirai-sf-healthcheck.service`        | success | 0              | 2026-11-04 14:35:00 |
| `mirai-sf-prod-healthcheck.service`   | success | 0              | 2026-11-04 14:35:00 |
| `mirai-sf-backup.service`             | success | 0              | 2026-11-04 02:30:00 |
| `mirai-sf-prod-backup.service`        | success | 0              | 2026-11-04 14:05:14 |
| `mirai-sf-restore-drill.service`      | success | 0              | 2026-11-01 03:30:33 |
| `mirai-sf-prod-restore-drill.service` | success | 0              | 2026-11-03 16:02:32 |

最新のバックアップ（mtime、14:37:05 JST に確認）:

- Staging: `mirai_sf-20261103T173000Z.dump`（2026-11-04 02:30、ファイル名は UTC）
- 本番: `mirai_sf_prod-20261104T050500Z.dump`（2026-11-04 14:05、ファイル名は UTC）

### 1-3. timer の次回（14:37:01 JST に取得）

| timer                               | NEXT（JST）         | 備考                                                  |
| ----------------------------------- | ------------------- | ----------------------------------------------------- |
| `mirai-sf-healthcheck.timer`        | 2026-11-04 14:40:00 | 5 分ごと                                              |
| `mirai-sf-prod-healthcheck.timer`   | 2026-11-04 14:40:00 | 5 分ごと                                              |
| `mirai-sf-prod-backup.timer`        | 2026-11-04 15:05:00 | 毎時 :05                                              |
| `mirai-sf-backup.timer`             | 2026-11-05 02:30:00 | 日次 02:30                                            |
| `mirai-sf-reminders.timer`          | 2026-11-05 08:30:00 | 日次 08:30                                            |
| `mirai-sf-restore-drill.timer`      | 2026-11-08 03:30:00 | 週次（日曜）                                          |
| `mirai-sf-prod-restore-drill.timer` | 2026-11-08 04:30:00 | 週次（日曜）。LAST は `-`（timer 有効化後の初回待ち） |

## 2. 判定（parity）

- `origin/main`（最後に取得した ref）: `26397fd7a25bd65832073e461acff5a403c6b8d3`。
- **本番は `origin/main` と一致**。Staging は `aeeddd9…` で、`26397fd` の**1 commit 遅れ**（`merge-base --is-ancestor` で
  Staging の commit が origin/main の祖先であることを確認）。差分は `26397fd fix(ui): 登録済み承認者を利用者IDで選択・保存 (#76)`。
- `/healthz` の `commit`・`environment`・`db.ok`、`current` と healthz の一致、healthcheck / backup / restore-drill の
  `Result=success`・`ExecMainStatus=0` は両環境とも正常。
- **未確認（今回の範囲外・読取りのみの制約）**: 公開ホスト名（Access / Tunnel）経由の到達性、`preview.conf` / `prod.conf`
  の内容、DB 名・接続先、worker の実 job の成否。設定ファイルは秘密値を含むため読んでいない。

→ Staging の 1 commit 遅れは、§3 の自動追従で解消する対象。本番は runbook（`02-runbook.md` §3）どおり手動リリースのまま。

## 3. Staging の main 自動追従

### 3-1. 仕組み

`scripts/ops/staging-autofollow.sh` が、既存の `release.sh` / `rollback.sh` の流儀をそのまま使う（新しい配備実装は足さない）。

1. `flock` で autofollow 同士の多重実行を防ぐ（2 本目は終了コード **75** で即終了。timer は成功扱い）。
2. `git fetch origin main` → `origin/main` の commit を **40 桁に固定**（古い情報のまま配備しない。fetch 失敗は中止）。
3. `current`（Staging の現行リリース）と比較し、同一なら **no-op**。ただし `/healthz` の `commit`・
   `environment`（既定 `staging`）・`db.ok` が一致しない場合は「追従済みなのに異常」として **exit 1**
   （黙って no-op にしない。別アプリ・誤 URL を成功と誤判定しないため environment も必須）。
4. 配備前に、実行元の controller が **main・clean** であり、HEAD が対象 SHA の祖先であることを確認する。
   **実行元の checkout は変更しない**。信頼済み controller の CI ゲートと release helper を使い、
   `release.sh` が対象 SHA の `git archive` を展開するため、controller が対象より古くてもアプリは自動追従する。
   local commits で diverged、dirty、feature ブランチの間は配備せず **exit 75**。
   controller 更新は timer/service の停止・対象main CI成功確認・ff-only同期の保守手順で別途行う。
5. 手動の `release.sh` / `rollback.sh` と同じ **`.ops.lock`** を取る。取れない（手動運用中）なら触らず exit 75。
   ロックは CI ゲートの間も保持し、ゲート中に手動配備が進まないようにする。取った後に `current` を読み直す
   （ゲート前の値を `previous` として使わない）。取れた場合は `OPS_LOCK_HELD=1` を子へ渡し、
   `release.sh` 側でロックを取り直さない（親子で同じロックを二重に取ると自分自身と衝突するため）。
6. **exact-main CI ゲート**（`scripts/ops/check-release-ci.mjs`）を通す。固定の
   `Kensan196948G/Software-Factory` / `ci.yml` / `event=push` / `branch=main` について、対象 SHA の
   最新 run の最新 attempt を `gh api --method GET` だけで取得し、次を必須にする:
   run の SHA/event/branch/path（`.github/workflows/ci.yml` 必須、欠落不可）と `created_at`、
   attempt の id/run_attempt/event/path/head_sha/head_branch が一覧と一致、attempt が `completed`/`success`、
   `quality` / `e2e` / `docker` の全 job が存在し `completed`/`success`、job 確認後の再取得でも
   同じ run/attempt のまま成功（再 run race 検出）。
   **まだ run が無い・実行中は exit 75（次の timer で再確認）**、run/attempt/job の失敗、必須 job の欠落/skipped、
   `created_at` 欠落、API 情報不足、gh/API の照会エラー（JSON 不正を含む）は **exit 1（timer を failed にして気づける）**。
   gh の stderr 本文はログへ出さず、終了コード・シグナル・errno の固定分類だけを出す。
   手動 override / bypass は無い。
7. 更新があれば `release.sh <40桁SHA>` を実行（main に含まれることの確認、`git archive`、`pnpm install/build`、
   事前バックアップ、migration、`current` 切替、再起動、`/healthz` の commit 確認、失敗時の旧版への自動復帰）。
8. 配備後に `/healthz` を**独立に**再確認し（最大 5 回・1 秒間隔、`commit`・`environment`・`db.ok`）、`current` も
   対象 SHA と照合する。だめなら `rollback.sh <直前のSHA>` で戻し、戻した先でも `/healthz` を確認する
   （戻すときも保持中の `.ops.lock` を子へ渡す）。
9. 成功後に古い `releases/` を整理する（`current`・`previous` と直近 N 世代を保持。既定 N=5。
   本番ホーム `*-prod` と `--dry-run` では何もしない）。
10. 結果を `~/.local/state/mirai-sf/autofollow.json`（0600）へ残す。`/healthz` の本文・設定値・秘密値はログへ出さない
    （出すのは確認済みの `status` / `environment` / `db.ok` / `commit` だけ）。

### 3-2. 終了コード

| コード | 意味                                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | 追従済み（no-op）または配備成功                                                                                                                            |
| 1      | 失敗（health 不一致、CI の恒久的な失敗・必須 job 欠落/skipped・created_at 欠落・API 情報不足・照会エラーなど。直前のリリースへ戻した場合を含む）             |
| 2      | 失敗して直前のリリースへ戻せなかった（手動で復旧する）                                                                                                     |
| 3      | 破壊的な可能性がある migration のため中止（`release.sh` の判定）                                                                                           |
| 75     | 配備しない（一時的）: 実行中、main・clean でない／diverged、exact-main CI の run がまだ無い・実行中（timer は成功扱い。次の回で再確認） |

### 3-3. 環境変数（検証用の差し替えを含む）

| 変数                                 | 既定                                      | 用途                                |
| ------------------------------------ | ----------------------------------------- | ----------------------------------- |
| `MIRAI_SF_REPO`                      | このスクリプトを含むリポジトリ            | 比較する git リポジトリ             |
| `MIRAI_SF_HEALTH_URL`                | `http://127.0.0.1:8782/healthz`           | 配備後・no-op 時の確認先            |
| `MIRAI_SF_RELEASE_SCRIPT`            | `scripts/ops/release.sh`                  | テストで偽スクリプトへ差し替え      |
| `MIRAI_SF_ROLLBACK_SCRIPT`           | `scripts/ops/rollback.sh`                 | 同上                                |
| `MIRAI_SF_HEALTH_ENV`                | `staging`                                 | 期待する environment（必須一致）    |
| `MIRAI_SF_AUTOFOLLOW_KEEP_RELEASES`  | `5`                                       | current/previous のほかに残す世代数 |
| `MIRAI_SF_AUTOFOLLOW_PRUNE`          | `1`                                       | `0` で releases の整理を無効化      |
| `MIRAI_SF_AUTOFOLLOW_STATE_FILE`     | `~/.local/state/mirai-sf/autofollow.json` | 実行結果の記録（0600）              |
| `MIRAI_SF_AUTOFOLLOW_HEALTH_RETRIES` | `5`                                       | 配備後の `/healthz` 試行回数        |

`release.sh` と共通の `MIRAI_SF_HOME` / `MIRAI_SF_ENV_FILE` / `MIRAI_SF_RESTART_HOOK` などは `scripts/ops/lib.sh` を参照。

### 3-4. timer の雛形

`deploy/systemd/mirai-sf-autofollow.service` / `.timer`（10 分ごと、`Persistent=true`、`SuccessExitStatus=75`、
`TimeoutStartSec=1800`）。実行元は `current` ではなく常設のチェックアウト（healthcheck と同じ理由）。
配備モードでは実行元が **main・clean** で対象 SHA の祖先であることを確認し、checkout は更新しない
（feature ブランチ・dirty・diverged は skip=exit 75）。
exact-main CI ゲートを通すため、配備は対象 SHA の push/main CI（quality / e2e / docker）が
成功してからになる。CI が timer 間隔（10 分）より長い場合は次の回で再確認する（exit 75）。
CI が失敗した場合・必須 job が欠落/skipped の場合は exit 1 になり、timer が failed になる
（成功扱いの 75 と区別し、`systemctl --user --failed` で気づける）。
push フックではなく定期確認なので、main の反映は CI 完了後に最大約 10 分遅れる。

## 4. 導入手順（2026-11-04 に実施済み。下記 4-1 に実測を記録）

```bash
# 0. マージ後の main を常設チェックアウトへ反映（unit はチェックアウトから実行する）
cd /mnt/storage/Software-Factory/Software-Factory
git switch main && git pull --ff-only

# 1. 計画の確認（配備・DB・サービスは変更しない。git fetch の refs と状態ファイルだけ更新する。
#    --dry-run は exact-main CI ゲートを照会しない）
bash scripts/ops/staging-autofollow.sh --dry-run

# 2. unit を配置して読み込み直す
cp deploy/systemd/mirai-sf-autofollow.service deploy/systemd/mirai-sf-autofollow.timer ~/.config/systemd/user/
systemctl --user daemon-reload

# 3. 1回手動で実行し、成功してから有効化する（この時点で Staging が配備される）
systemctl --user start mirai-sf-autofollow.service
systemctl --user show -p Result -p ExecMainStatus mirai-sf-autofollow.service
journalctl --user -u mirai-sf-autofollow -n 40 --no-pager
cat ~/.local/state/mirai-sf/autofollow.json

# 4. timer を有効化
systemctl --user enable --now mirai-sf-autofollow.timer
systemctl --user list-timers mirai-sf-autofollow.timer
```

有効化後は `mirai-sf-healthcheck.timer`（5 分ごと）と併用する。healthcheck は「配備済みの commit と healthz の一致」を、
autofollow は「origin/main への追従」を見る。役割が違うため両方必要。

### 4-1. 実施記録（2026-11-04 JST）

- 15:25 に Staging を `207567b`（PR #77〜#79 マージ後の main）へ手動配備し、healthz の commit 一致を確認した。
- 15:29 に `mirai-sf-autofollow.service` / `.timer` を `~/.config/systemd/user/` へ配置し、`enable --now` した。timer は 10 分間隔で active。
- 15:26 の手動実行は **no-op / exit 0**（current と origin/main が同一、`status=ok environment=staging db.ok=true commit` 一致）。
- 初回実行は `git fetch` が `Invalid username or token` で失敗した。原因は systemd --user の環境変数に残った失効済みの `GITHUB_TOKEN` が `gh auth git-credential`（`~/.config/gh/hosts.yml`）より優先されたこと。unit に `UnsetEnvironment=GH_TOKEN GITHUB_TOKEN GITHUB_PAT_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN` を追加して解消した。
- 本PR（exact-main CI ゲート）はコード追加のみ。常設チェックアウトへの反映と unit の再読込は Lead が
  対象 SHA の main CI 完了後に実施する。旧ゲート無しcontrollerは先にtimerを停止し、停止中に同期してから再開する。
- **別課題（セキュリティ）**: `systemctl --user show-environment` に複数の資格情報が残っている。autofollow は UnsetEnvironment で回避したが、恒久対策は「user manager の環境から秘密を外し、必要なサービスだけ EnvironmentFile（0600）で読む」こと。値は本書・リポジトリ・ログに書かない。トークンのローテーション要否は所有者が判断する。

## 5. 検証結果（2026-11-04）

| 検証                                                                   | 結果                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------- |
| `bash -n scripts/ops/staging-autofollow.sh`                            | 成功                                              |
| `shellcheck -x scripts/ops/staging-autofollow.sh`                      | 指摘なし（exit 0）                                |
| `bash -n scripts/ops/tests/staging-autofollow.test.sh`                 | 成功                                              |
| `shellcheck -x scripts/ops/tests/staging-autofollow.test.sh`           | 指摘なし（exit 0）                                |
| `node --check scripts/ops/check-release-ci.mjs`                        | 成功                                              |
| `node scripts/ops/check-release-ci.mjs`（引数なし）                    | 終了コード 1（照会エラー）                        |
| `bash scripts/ops/tests/staging-autofollow.test.sh`                    | **PASS 122 / FAIL 0**（35 シナリオ、shellcheckあり。無しは120・静的2件skip）              |
| `pnpm test:ops`                                                        | 同上（単体テストを1コマンドで実行）               |
| GitHub REST API 仕様                                                   | Context7（workflow runs / attempts / jobs）で確認 |
| `node scripts/ops/check-release-ci.mjs 8a1ee99…`（read-only 実ゲート） | OK（run=41801003971 attempt=1、exit 0）           |
| `node scripts/secret-scan.mjs`                                         | OK（280 ファイル）                                |
| `pnpm typecheck`                                                       | 成功（exit 0、2026-11-04 18:52 JST）              |
| `pnpm lint`                                                            | 成功（exit 0、`--max-warnings=0`）                |
| `pnpm test:unit`                                                       | 18 ファイル / **644 tests passed**（exit 0）      |

テスト（`scripts/ops/tests/staging-autofollow.test.sh`）は実サービス・実 DB・実リポジトリに触れず、一時ディレクトリに
「origin がベアリポジトリの git リポジトリ」「偽の release.sh / rollback.sh」「偽 `/healthz` サーバー」を作って検証する。

1. 同一 commit は no-op（release.sh を呼ばない）
2. 更新があれば `origin/main` の 40 桁 SHA で配備し、`current` と `/healthz` が一致する
2b. controller が対象 SHA より古くても、checkout を変更せず target を配備する（HEAD 不変も確認）
3. 配備後の `/healthz` 不一致は exit 1 で、`rollback.sh` により直前のリリースへ戻る
4. 追従済みでも `db.ok=false` は異常（exit 1）
5. ロック中の実行は exit 75 で、release.sh を呼ばない（多重実行防止）
6. `--dry-run` は配備しない
7. `release.sh` の失敗は exit 1・`current` は元のまま
8. 不正なオプションは exit 1
9. 手動の release/rollback が `.ops.lock` を保持している間は exit 75・release.sh を呼ばない
10. 実行元が main 以外（feature ブランチ）なら exit 75・release.sh を呼ばない
11. 実行元に未コミットの変更があれば exit 75・release.sh を呼ばない
12. `/healthz` の `environment` が `production`（別アプリを想定）なら exit 1・直前へ戻す
13. 成功後に古い releases を整理し、current/previous と直近5世代だけ残す
14. exact-main CI: 別 SHA の run は exit 75・release.sh を呼ばない
15. exact-main CI: event が push でない run は exit 1（workflow 設定の異常として気づく）
16. exact-main CI: branch が main でない run は exit 1
17. exact-main CI: 過去 attempt が success でも最新 attempt が未完了なら exit 75
18. exact-main CI: 必須 job が skipped なら exit 1
19. exact-main CI: 必須 job が欠けていれば exit 1
20. exact-main CI: gh/API エラーは exit 1（75 ではない）・release.sh を呼ばない
21. exact-main CI: run が failure なら exit 1（timer が failed になり気づける）
22. exact-main CI: 必須 job が未完了なら exit 75
23. 実行元が diverged（local commits）なら exit 75（controller を変更しない）
24. exact SHA の run が無ければ exit 75
25. run.path が欠落した応答は exit 1（fail-closed）
26. attempt のメタデータ（id/run_attempt/event/path 等）が一覧と不一致なら exit 1
27. job 確認後に新しい attempt が現れたら exit 75（再 run race）
28. API 情報不足（attempt の必須項目欠落）は exit 1
29. created_at が欠落した run は最新を決められないので exit 1
30. job の head_sha が欠落したら exit 1
31. JSON不正なら照会不能としてexit 1
32. 新しいrunのhead_sha欠落を、古いsuccessで補わずexit 1
33. runs一覧のtotal_count不一致（未取得ページ）はexit 1
34. jobs一覧のtotal_count不一致（未取得ページ）はexit 1

`tests/unit/staging-ci-gate.test.ts` がこの隔離shell suiteを呼ぶため、既存必須quality jobのunit testで
全シナリオが毎回走る（workflow変更なし、実サービス・実DB・実GitHubへの接続なし）。

補足: シナリオ20内で gh の stderr 本文（合成マーカー）が stdout/stderr に出ないことも確認する。
シナリオ9はロック中にCIを照会しないこととcontrollerのHEAD不変も確認する。
no-op / dry-run は配備を行わないためCIゲート対象外（exit 0 はCI合格を意味しない）。
queryで非push・非mainは除外されるので、該当runしか無い実APIでは75（push/main run無し）になる。
15/16はqueryに反する不正API応答を模擬した防御試験で、その場合は1になる。

## 6. 運用

| 操作          | コマンド                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| 状態を見る    | `cat ~/.local/state/mirai-sf/autofollow.json` / `journalctl --user -u mirai-sf-autofollow`                    |
| 手動で追従    | `bash scripts/ops/staging-autofollow.sh`                                                                      |
| 計画だけ確認  | `bash scripts/ops/staging-autofollow.sh --dry-run`（fetch と状態ファイルのみ更新。CI ゲートは照会しない）     |
| CI ゲート確認 | `node scripts/ops/check-release-ci.mjs <SHA>`（0=可 / 75=一時的な未確認 / 1=失敗・照会不能） |
| テスト        | `pnpm test:ops`                                                                                               |
| 止める        | `systemctl --user disable --now mirai-sf-autofollow.timer`（unit は消さない）                                 |
| 手動で戻す    | `pnpm ops:rollback --dry-run <SHA>` → `pnpm ops:rollback <SHA>`（DB は戻さない）                              |
| failed の確認 | `systemctl --user --failed` / `systemctl --user show -p Result -p ExecMainStatus mirai-sf-autofollow.service` |

失敗時（exit 1/2）は autofollow が旧版を維持しようとするが、**exit 2 は戻せなかった**という意味なので、
`/healthz` と `current` を確認し、runbook の一次対応に沿って手動で復旧する。
exit 1 は「CI の恒久的な失敗・必須 job 欠落/skipped・created_at 欠落・API 情報不足・照会エラー」で、
timer が failed になる（確認できるまで配備しない）。
exit 75 は「一時的に配備しない」で、CI の run 未作成・実行中、または実行中/作業ツリー不一致/diverged を含む
（timer は成功扱い。次の回で再確認する）。
CI の状態は `gh run list --workflow ci.yml --commit <SHA>` 等で確認できる。**CI 待ちを飛ばす bypass は無い。**

## 7. 既知の制約

- push フックではないため、main の反映は最大約 10 分遅れる（timer の間隔）。
- **exact-main CI の run がまだ無い・実行中の間は配備しない（exit 75）。** CI 完了まで
  最大で CI 所要時間（quality / e2e / docker）＋10 分待つ。CI 待ちを飛ばす override / bypass は無い。
  **CI の失敗・必須 job の欠落/skipped は exit 1** で timer が failed になる（成功扱いの 75 と区別する）。
- CI ゲートは `gh` の認証（gh auth / hosts.yml）に依存する。gh/API エラーは exit 1（failed）で、
  古い情報のまま配備しない。gh の stderr 本文（URL・トークン等を含み得る）はログへ出さず、
  終了コード・シグナル・errno の固定分類だけを出す。ゲートは repo / workflow（ci.yml）/
  event（push）/ branch（main）/ 必須 job（quality・e2e・docker）を固定しており、変更時は
  ゲートも更新する。
- controller の checkout は自動更新しない。main・clean・HEAD が対象 SHA の祖先であることを要求し、
  local commits で diverged、dirty、feature ブランチの間は配備しない（exit 75）。
  アプリは `git archive <target>` で追従する。controller 修正の反映は停止・CI確認・ff-only同期の保守作業が必要。
- `release.sh` は main に含まれる commit だけを配備する。force push・履歴改変後の old commit には追従しない。
- migration は additive 前提。破壊的候補があれば exit 3 で停止し、DB も `current` も変えない（`release.sh` の既存判定）。
- 配備は `pnpm install` / `pnpm build` を含むため数分かかる。`TimeoutStartSec=1800` を超えると unit は失敗する。
  実行がタイマー間隔（10 分）を超えた場合に限り、次回の timer 実行は flock で exit 75（成功扱い）になり、
  二重配備は起きない。
- 実行元が main・clean でない間は配備しない（exit 75）。dev ツリーを `main`・clean に保つか、専用チェックアウトを
  `ExecStart` にすること（unit の `WorkingDirectory` を差し替える）。
- `releases/` の整理は Staging ホームだけで行う。本番ホーム（`*-prod`）では実行しない。
  `MIRAI_SF_AUTOFOLLOW_PRUNE=0` で無効化でき、`MIRAI_SF_AUTOFOLLOW_KEEP_RELEASES` で保持数を変えられる。
- Staging の `mirai-sf-worker.service` が active のため、配備時に `release.sh` が worker を再起動する（既存挙動）。
  実行中の AI job は止まり、次回起動で同じ工程からやり直す。止めたい場合は `systemctl --user disable --now mirai-sf-worker.service`。
- 本番には適用しない。本番は `docs/production/02-runbook.md` §3 の手動リリース（`pnpm ops:prod:release`）のまま。
- `git fetch` は手動リリースと同じ資格情報（credential helper 等）に依存する。`GIT_TERMINAL_PROMPT=0` で
  対話待ちはしない。取得に失敗したときは配備せず exit 1（古い情報のまま配備しない）ので、timer の failed と journal で気づける。
- 実配備・timer 有効化・本番/Staging の設定変更・Cloudflare 操作は本 PR では行っていない。

## 8. 既知の残存リスク（本PRでは変更しない）

2026-11-04 の読取監査で確認したが、本PRの範囲外として広範修正しないもの。exact-main CI ゲートは
「配備前の CI 成功」を保証するが、以下は保証しない。

- **`.ops.lock` の信頼境界**: `scripts/ops/lib.sh` の `ops_lock_ops` は `OPS_LOCK_HELD=1` を信頼する
  助言的排他で、fd の実保持を検証しない。release.sh の子（pnpm install/build・backup・migration）へ
  env と fd が継承される。autofollow は CI ゲートの間もロックを保持し、ゲート中の手動配備を防ぐが、
  同一ユーザーの任意プロセスに対するセキュリティ境界ではない。
- **controller の更新**: 実行中の自己書換えはしない。信頼済みmain checkoutのコードを使い続けるため、
  gate/helperの変更時はtimerとserviceの停止・対象main CI成功確認・ff-only同期・再開が必要。
  appの配備対象はcontrollerより新しくてよい（targetのgit archiveを配備）。
- **CI 確認から配備開始までの TOCTOU**: 最後の run 一覧取得と `release.sh` 開始の間に re-run が
  始まる可能性は残る（原子的ではない）。ゲートは「確認した時点で最新 attempt が success」を保証する。
- **run/job 一覧のページング**: `per_page=100` の1ページと `total_count` を照合し、不一致は配備しない（exit 1）。
  100件超を扱うにはページング実装が必要だが、不完全な一覧の古いsuccessを使うことはない。
  run必須メタデータ欠落はfilter前に拒否し、新しい不完全runを除外して古いsuccessに代替しない。
- **RPO 1h の保証**: 55 分の開始間隔だけでは保証できない。`docs/production/07-slo-and-measurement.md`
  §3-4 は是正前の最大間隔 60.2 分・60 分超 4 回を記録し、是正後は未計測。`measure-slo.mjs` は最新 dump の
  鮮度のみで判定し、healthcheck の鮮度閾値は 90 分、外部通知は未実装。
- **R2 の同一ホスト依存**: `backup.sh` が同一ホストで送信し、送信記録もローカル。wrangler の OAuth に依存し、
  送信記録が無い dump がある（07 §3-4）。ホスト障害時の独立コピー・復元手順としては未検証
  （`docs/production/02-runbook.md` §5）。
- **releases の rollback 可用性**: prune は current/previous と直近 5 世代のみ保持。それより古い rollback は
  `rollback.sh` では不可で再リリースが必要（`docs/deployment.md` の「自動削除はしない」と不整合）。
- **配備後の provenance**: `/healthz` の commit は `release.env` の自己申告。CI ゲートは配備前の CI だけを
  見て、配備後の `dist` が対象 SHA 由来であることは検証しない。
- **資格情報の衛生**: user manager 環境の秘密は未解消（`docs/production/08-credential-hygiene.md`）。
  autofollow unit は GitHub 系のみ unset し、配備時の `pnpm install/build` は main のコードを user 環境で実行する。
