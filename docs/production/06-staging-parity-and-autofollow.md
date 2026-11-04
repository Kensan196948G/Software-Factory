# Staging の main 自動追従と Staging/本番の状態（実測）

対象: Staging（`127.0.0.1:8782` / `mirai-sf-api.service`）と本番（`127.0.0.1:8783` / `mirai-sf-prod-api.service`）。
目的: (1) 2026-11-04 時点の健全性を**読み取りのみ**で実測して証跡を残す、(2) main が進んだら Staging が自動で
追従し、失敗時は旧版を維持する仕組みを用意する。

> 本作業ではサービス再起動・配備・設定変更・Cloudflare 操作・DB 書込みをしていない。
> 自動追従の **timer のインストールと有効化は未実施**（Lead が行う）。§4 の手順は「実施の許可」ではない。

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
4. 配備前に、実行元のチェックアウトが **main・clean** か確認する（ブランチ切替中のコードを 10 分毎に配備しない。
   違えば配備せず exit 75）。
5. 手動の `release.sh` / `rollback.sh` と同じ **`.ops.lock`** を取る。取れない（手動運用中）なら触らず exit 75。
   取れた場合は `OPS_LOCK_HELD=1` を子へ渡し、`release.sh` 側でロックを取り直さない（親子で同じロックを
   二重に取ると自分自身と衝突するため）。
6. 更新があれば `release.sh <40桁SHA>` を実行（main に含まれることの確認、`git archive`、`pnpm install/build`、
   事前バックアップ、migration、`current` 切替、再起動、`/healthz` の commit 確認、失敗時の旧版への自動復帰）。
7. 配備後に `/healthz` を**独立に**再確認し（最大 5 回・1 秒間隔、`commit`・`environment`・`db.ok`）、`current` も
   対象 SHA と照合する。だめなら `rollback.sh <直前のSHA>` で戻し、戻した先でも `/healthz` を確認する
   （戻すときも保持中の `.ops.lock` を子へ渡す）。
8. 成功後に古い `releases/` を整理する（`current`・`previous` と直近 N 世代を保持。既定 N=5。
   本番ホーム `*-prod` と `--dry-run` では何もしない）。
9. 結果を `~/.local/state/mirai-sf/autofollow.json`（0600）へ残す。`/healthz` の本文・設定値・秘密値はログへ出さない
   （出すのは確認済みの `status` / `environment` / `db.ok` / `commit` だけ）。

### 3-2. 終了コード

| コード | 意味                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------ |
| 0      | 追従済み（no-op）または配備成功                                                                        |
| 1      | 失敗（health 不一致など。直前のリリースへ戻した場合を含む）                                            |
| 2      | 失敗して直前のリリースへ戻せなかった（手動で復旧する）                                                 |
| 3      | 破壊的な可能性がある migration のため中止（`release.sh` の判定）                                       |
| 75     | 実行中（autofollow／手動 release/rollback）または実行元が main・clean でない（skip。timer は成功扱い） |

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
ただし配備モードでは実行元が **main・clean** であることを確認する（dev ツリーが feature ブランチの間は skip=exit 75）。
push フックではなく定期確認なので、main の反映は最大約 10 分遅れる。

## 4. 導入手順（Lead が実施。本 PR では未実施）

```bash
# 0. マージ後の main を常設チェックアウトへ反映（unit はチェックアウトから実行する）
cd /mnt/storage/Software-Factory/Software-Factory
git switch main && git pull --ff-only

# 1. 計画の確認（配備・DB・サービスは変更しない。git fetch の refs と状態ファイルだけ更新する）
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

## 5. 検証結果（2026-11-04）

| 検証                                                         | 結果                                         |
| ------------------------------------------------------------ | -------------------------------------------- |
| `bash -n scripts/ops/staging-autofollow.sh`                  | 成功                                         |
| `shellcheck -x scripts/ops/staging-autofollow.sh`            | 指摘なし（exit 0）                           |
| `bash -n scripts/ops/tests/staging-autofollow.test.sh`       | 成功                                         |
| `shellcheck -x scripts/ops/tests/staging-autofollow.test.sh` | 指摘なし（exit 0）                           |
| `bash scripts/ops/tests/staging-autofollow.test.sh`          | **PASS 52 / FAIL 0**（13 シナリオ）          |
| `pnpm test:ops`                                              | 同上（単体テストを1コマンドで実行）          |
| `pnpm typecheck`                                             | 成功（exit 0、2026-11-04 14:53 JST）         |
| `pnpm lint`                                                  | 成功（exit 0、`--max-warnings=0`）           |
| `pnpm test:unit`                                             | 18 ファイル / **644 tests passed**（exit 0） |

テスト（`scripts/ops/tests/staging-autofollow.test.sh`）は実サービス・実 DB・実リポジトリに触れず、一時ディレクトリに
「origin がベアリポジトリの git リポジトリ」「偽の release.sh / rollback.sh」「偽 `/healthz` サーバー」を作って検証する。

1. 同一 commit は no-op（release.sh を呼ばない）
2. 更新があれば `origin/main` の 40 桁 SHA で配備し、`current` と `/healthz` が一致する
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

## 6. 運用

| 操作          | コマンド                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| 状態を見る    | `cat ~/.local/state/mirai-sf/autofollow.json` / `journalctl --user -u mirai-sf-autofollow`                    |
| 手動で追従    | `bash scripts/ops/staging-autofollow.sh`                                                                      |
| 計画だけ確認  | `bash scripts/ops/staging-autofollow.sh --dry-run`（fetch と状態ファイルのみ更新）                            |
| テスト        | `pnpm test:ops`                                                                                               |
| 止める        | `systemctl --user disable --now mirai-sf-autofollow.timer`（unit は消さない）                                 |
| 手動で戻す    | `pnpm ops:rollback --dry-run <SHA>` → `pnpm ops:rollback <SHA>`（DB は戻さない）                              |
| failed の確認 | `systemctl --user --failed` / `systemctl --user show -p Result -p ExecMainStatus mirai-sf-autofollow.service` |

失敗時（exit 1/2）は autofollow が旧版を維持しようとするが、**exit 2 は戻せなかった**という意味なので、
`/healthz` と `current` を確認し、runbook の一次対応に沿って手動で復旧する。

## 7. 既知の制約

- push フックではないため、main の反映は最大約 10 分遅れる（timer の間隔）。
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
