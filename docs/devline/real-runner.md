# 開発ライン 実 AI ランナーと実 PR（docker-claude）

状態: 実装済み。**1件実走の確認済み**（2026-11-01、11 章）。作り物の注文書で `pr_ready` まで到達した（AC 証跡の取り込みより前の記録）。本番と実データには使っていない。
既定は fake のまま。`DEVLINE_RUNNER_KIND=docker-claude` のときだけ動く。画面の投入も同じ設定で実 job を作る（13 章。fake GitHub と stub docker でのみ確認、実走は未実施）。

## 1. 所有者の決定

| 項目       | 値                                                                                    |
| ---------- | ------------------------------------------------------------------------------------- |
| 接続先     | private repo `Kensan196948G/Software-Factory-Sandbox`（repo ID 1440860477）           |
| データ     | 作り物だけ                                                                            |
| 費用の上限 | 1タスク 1,000 円。超えたら自動停止。延長なし（`DEVLINE_BUDGET_JPY` は 1000 以下だけ） |
| AI の認証  | `ANTHROPIC_API_KEY`。サブスクリプションの認証情報は使わない                           |
| GitHub     | 専用の `DEVLINE_GITHUB_TOKEN`。ホストの gh 認証と `GITHUB_TOKEN` は使わない           |

## 2. 流れ

```
handoff（Issue）→ queued → planning（AI・読むだけ）→ implementing（AI）
  → ホストの差分検査 → ホストで commit → push → PR（CI の前に作る）
  → verifying（GitHub Actions の結果を読む）→ pr_ready（本文を結果つきに更新）で止まる
```

- **AI は merge も Approve もしない**。`pr-adapter.ts` にその口が無い。job は `pr_ready` で人の承認を待つ。
- 合否の根拠は Actions の記録だけ（`verification.source='github'`）。AI の申告は使わない。受入条件は同じ run の artifact `ac-results` から読む（14 章）。
- `pr_ready` は「PR 候補の準備完了」で、受入の合格ではない。merge の判断は人が行う。
- CI の失敗は `revising`。修正は直前の head から始め、**試行ごとに新しいブランチと PR** を作る（`auto/<req>-v<版>-a<試行>`）。force push を避けるため。古い PR はマーカーと作成者を確かめて閉じる。差分検査は常に base からの全体で行う。

### 止まる場合

| 条件                                                                              | 止まり方                                                                                  |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 資格情報なし・0600 以外・symlink・他人のファイル                                  | 起動を拒否（fake へ落とさない）                                                           |
| 許可リスト外・定数の repo 以外・repo ID 不一致・public                            | 起動を拒否。動作中なら `policy_violation`                                                 |
| `NODE_ENV=production`                                                             | 起動を拒否。投入も ERR-405（Staging の現在の設定がこれにあたる。13 章）                   |
| artifact は読めて AC の試験が足りない（未確認、`not_run`、未知の ID、重複、欠落） | `revising`（どの AC かを AI へ渡す。同因 2 回・合計 5 回の上限の中で。AI の費用がかかる） |
| `ac-results` が読めない、取得元が合わない、再開で同じ run を読み直した            | `ci_incomplete`。理由に「AC 未確認」を出す                                                |
| 別の worker が動いている（advisory lock を取れない）                              | 起動を拒否。コンテナの片付けもしない                                                      |
| 禁止差分・追加の中身の秘密・バイナリ（4章）                                       | `policy_violation`。commit も push もしない                                               |
| 既存の試験の変更・削除・移動（前の試行で足した試験を含む）                        | `human_approval_required`。push しない                                                    |
| 予算の到達・CLI が予算で停止                                                      | `budget_limit`。再開不可                                                                  |
| workflow が base と別の blob                                                      | `policy_violation`                                                                        |
| CI の結果が揃わない（skip・cancelled・段階名の不一致・run の不成功）              | 待たずに `ci_incomplete`。理由を `stop_detail` に出す。CI を再実行して再開する            |
| heartbeat・待ちの例外、worker の排他を失った                                      | AI を止めて片付け、結果を待って費用を数え `runner_failure`                                |
| CLI を起動できない（`docker run` の 125〜127 で出力なし）                         | 0 円で `runner_failure`（`notStarted`）。再開できる                                       |
| 隔離ネットワークを用意できない                                                    | 0 円で `runner_failure`。段階と stderr を成果物に残す                                     |

費用の規則（少なく数えない。同じ試行を二重に数えない）:

| 実行の結果                                             | 計上                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| CLI の結果を読めた                                     | CLI の申告（円へ切り上げ）。後の検査が例外でも保つ                                                                  |
| CLI が動いたはずなのに結果が読めない（時間切れ・取消） | 渡した `--max-budget-usd` をまるごと（多くは `budget_limit`）                                                       |
| CLI が動いていないと確実に分かる                       | 0 円                                                                                                                |
| worker が落ちて試行が開いたまま                        | 再取得で試行を `discarded` で閉じ、`job_attempt.allotment_jpy` を計上してから先へ進む。使い切ったら AI を動かさない |

検査を通らなかった結果（policy 違反、試験の変更、成果物の hash や大きさの偽り）は記録の前に判定する。試行を `rejected` で閉じ、成果物を追記のみの表へ入れない。費用は数える。

PR 本文の変更一覧は 100 件・1 path 300 文字で切り詰め、本文全体も `job_artifact` の上限（262,144 bytes）に収める。上限を超えて `pr_ready` の記録が rollback されることはない。

SIGINT / SIGTERM（`systemctl stop` を含む）: 動いている AI を止め、試行を `cancelled` で閉じ、費用を数え、lease を外して終わる。job の状態は動かさないので、次の起動で同じ工程からやり直す。

### 実 PR の後始末

worker が取得の前に確かめる（`prFollowupOf`）。常駐の worker は全 job を見る。1件実走の入口は自分の job だけを見るので、以前の実走の PR（Sandbox #3 など）には触らない。外部呼び出しは handoff の commit の外で、結果は `work_state.prFollowup` と event `pr_followup` に残す。失敗は 1 分以上空けて 10 回まで試す。触る前にマーカーと作成者を確かめ、自分のものでない PR には触らない。merge はしない。

| job の状態                                                  | PR の扱い                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| 古い版（`superseded_at`）・注文書が無効・`cancelled`        | 閉じる。`pr_ready` のままでも閉じる                          |
| 再開できない停止（`budget_limit`・`policy_violation` など） | 閉じる（人は読めるし開き直せる）                             |
| 再開できる停止（`cancel_requested`・`ci_incomplete` など）  | 開いたまま本文に「merge しない」印を付ける。合格すれば消える |
| push の直後に fence が切れて記録できなかった PR             | その場で閉じる（event `pr_stranded`）                        |

## 3. 隔離

- コンテナ: `--rm --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --pids-limit --memory --cpus`、実行ユーザーはホストの uid（root では動かさない）。
- bind mount は作業ツリーだけ。**gitdir は作業ツリーの外**に置く（AI が hooks や config を書いても、ホストの git が実行しない）。ホーム・`.ssh`・`.claude` はマウントしない。
- 環境変数は `ANTHROPIC_API_KEY`・`HTTPS_PROXY`・`HTTP_PROXY`・`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`・`DISABLE_AUTOUPDATER` だけ。key は docker の argv に載せない（`--env ANTHROPIC_API_KEY` で引き継ぐ）。GitHub トークンは渡さない。
- 通信: `--internal` かつ `com.docker.network.bridge.inhibit_ipv4=true` のネットワーク（既定の経路なし、ホスト側のブリッジに IP なし）。出口は `deploy/devline/egress-proxy.mjs` の CONNECT だけで、許可先はコードの定数 `api.anthropic.com:443`。`--dns 127.0.0.1` で内蔵 DNS の外への転送先を潰す。
- ホストの git: 環境を空から作り、`GIT_CONFIG_NOSYSTEM`・`GIT_CONFIG_GLOBAL=/dev/null`・`core.hooksPath=/dev/null` など。トークンは fetch / push の子プロセスの `GIT_CONFIG_*`（`http.<origin>/.extraHeader`）だけで、`.git/config` と argv に残さない。リダイレクトを追わない。
- clone 先の `.claude/`・`.mcp.json`・`CLAUDE.md`（深さによらず）は実行前に作業場から除く。`--bare` が無視するかに依存しない。base の内容は commit で保たれる。作り直すと差分検査で拒否する。
- コンテナは名前とラベル（`msf.devline=1`）を持ち、時間切れ・取消で `docker kill`。中でも `timeout --signal=KILL` で切るので worker が落ちても動き続けない。**worker は PostgreSQL の advisory lock で DB ごとに1台に強制する**。取れなければ起動を拒否する。取れたときだけ、同じ DB の範囲（ラベル `msf.devline.scope`）の残骸を片付ける。接続を失うとロックも失うので、新しい AI を動かさず、動いている AI を止める。コンテナが作られる前の取消は `docker run` が終わるまで kill を繰り返して受ける。
- プロンプトは注文書を毎回違う区切りの中のデータとして渡し、Issue 本文や README は未信頼と明記する。`requested_by`・`approver` の行と承認者の ID は渡さない（M-7）。

## 4. 差分検査（`src/worker/diff-policy.ts`）

`git add --all` の後の `git diff --cached --raw -z -M <base>` だけで判定する。リポジトリごとの policy（`diffPolicyForRepo`。版は `work_state.diffPolicy` と停止の記録に残す）。

| 拒否                                                                                                                                    | 規則                       |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| mode 120000（symlink）・160000（submodule・入れ子の .git）。追加でも削除でも                                                            | `symlink` / `submodule`    |
| `.git/`・`.github/`・`.claude/`・`.mcp.json`・`CLAUDE.md`・`CLAUDE.local.md`・`.gitmodules`・`.gitattributes`（深さ・大小文字によらず） | `forbidden`                |
| secret 類・配備の定義                                                                                                                   | `forbidden`                |
| リネームの両側（禁止の場所から出す・入れる）                                                                                            | `rename_forbidden`         |
| Sandbox: `src/`・`test/`・`docs/`・`README.md` の外（`package.json` を含む）                                                            | `not_allowed`              |
| 作業ツリー直下の `.git`、200MB 超、200 ファイル超、計画の工程での変更                                                                   | `git_dir_in_worktree` ほか |
| 追加の中身の秘密（下記）。path の中の秘密                                                                                               | `secret_detected`          |
| バイナリ（NUL を含むか UTF-8 として読めない）。画像も含めて全部拒否する                                                                 | `binary_file`              |
| 1 ファイル 5MiB 超（中身を検査できない）                                                                                                | `file_too_large_to_scan`   |

中身の検査（`src/worker/secret-scan.ts`）は host で index の blob を読む。古い内容に同じ行が無い行を「追加」とする（`git diff` の出力に頼らない）。

- 実値: `ANTHROPIC_API_KEY` と `DEVLINE_GITHUB_TOKEN`。そのまま・base64・hex・逆順と、文字列の連結や折り返しで分けたもの。
- 形: `sk-ant-`・`gh[pousr]_`・`github_pat_`・秘密鍵ブロック・`AKIA`・`xox?-`・パスワード付き接続文字列・`Authorization` ヘッダ。誤検知は人の確認で扱う（`policy_violation` は再開できない。範囲を変えて新しい版にする）。
- 記録に残すのは path（伏せ字にしたもの）・規則・検出器の名前・行番号だけで、値は残さない。
- 修正の工程では直前の head とも比べる。前の試行で足した試験も、この試行から見れば既存の試験として `human_approval_required` にする。

検出できないもの: 暗号化や任意の符号化をした秘密、CLI の申告や通信の中身（プロキシの許可先は Anthropic だけ）。`docs/devline/security-residuals.md` の R-1。

工場のリポジトリの定義（`FACTORY_DIFF_POLICY`）は別にあるが、実 runner は `REAL_RUNNER_POLICY.allowedRepos` に載っていないので工場へは向かない。

## 5. 予算

- `DEVLINE_BUDGET_JPY`（既定 1000、上限 1000）、`DEVLINE_JPY_PER_USD`（既定 160。100 未満は拒否）。
- `--max-budget-usd` = (残額 ÷ 為替) を 0.01 ドル単位で切り捨て。0.01 未満なら動かさない。
- `total_cost_usd` を円へ切り上げて `job.cost_jpy` に足す。80% を初めて超えたら `budget_warning`。上限ちょうどで `budget_limit`。
- CLI の費用は概算で上限を超えうる。**1,000 円は最後の工程の分だけ超えることがある**（超過を検出して止めるので、次の工程へは進まない）。Anthropic Console 側の利用上限も併用する。
- 新しい版の job は別のタスクとして 0 円から数える（再承認は人の判断）。

## 6. 環境変数（値はリポジトリに書かない）

資格情報のファイル `~/.config/mirai-sf/devline-secrets.env`（0600・本人所有・通常ファイル）。worker の実行時だけ読み、`process.env` へ入れない。

```
ANTHROPIC_API_KEY=
DEVLINE_GITHUB_TOKEN=
```

| 変数                     | 既定                            | 意味                                                |
| ------------------------ | ------------------------------- | --------------------------------------------------- |
| `DEVLINE_WORKER_ENABLED` | なし                            | `1` で worker が動く                                |
| `DEVLINE_RUNNER_KIND`    | `fake`                          | `docker-claude` で実 runner                         |
| `DEVLINE_TARGET_REPOS`   | なし（1件実走の入口は Sandbox） | `Kensan196948G/Software-Factory-Sandbox:1440860477` |
| `DEVLINE_BUDGET_JPY`     | `1000`                          | 1タスクの上限（1000 以下）                          |
| `DEVLINE_JPY_PER_USD`    | `160`                           | 円換算                                              |
| `DEVLINE_SECRETS_FILE`   | 上記の path                     | 資格情報のファイル                                  |
| `DEVLINE_GIT_BASE_URL`   | `https://github.com`            | git の接続先                                        |
| `GITHUB_API_URL`         | `https://api.github.com`        | API の接続先                                        |
| `DEVLINE_CI_POLL_MS`     | なし（15〜30秒）                | 1件実走の入口の CI の問い合わせ間隔                 |

## 7. 1件実走の手順（CTO）

前提: 8章の Sandbox の構成、Docker、Node 22、専用の DB。

```bash
# 1. イメージを作る
docker build -f deploy/devline/Dockerfile.runner -t msf-devline-runner:2.1.316 deploy/devline
docker build -f deploy/devline/Dockerfile.proxy  -t msf-devline-egress-proxy:v1 deploy/devline
pnpm test:docker                # 実 Docker の確認。外部へは送らない

# 2. DB（名前は _dev / _test / _devline で終わること。Staging の DB は拒否する）
createdb -h /var/run/postgresql mirai_sf_devline
#   DATABASE_URL / MIGRATION_DATABASE_URL をこの DB にした設定ファイルを MIRAI_SF_CONFIG_FILE で指定する
pnpm db:migrate

# 3. 資格情報（値を画面やシェルの履歴に出さない）
install -m 600 /dev/null ~/.config/mirai-sf/devline-secrets.env
#   エディタで 2 つの変数を書く

# 4. dry-run（送信なし）
node scripts/local-run.mjs tsx scripts/devline-real-run.ts

# 5. 実走（作り物の注文書で1回）
node scripts/local-run.mjs tsx scripts/devline-real-run.ts --confirm-real-run
```

出力は段階ごとに「実行確認済み / 未到達 / 失敗」。job は `pr_ready` で止まる。Sandbox の PR を人が確認し、merge または close する。

戻し方: `docker kill`（ラベル `msf.devline=1`）、Sandbox の PR を閉じてブランチを消す、資格情報のファイルを消してキーとトークンを失効する。工場の DB には `0010` と `0011` の列と CHECK の拡張（additive）だけが入る。

## 8. Sandbox に必要な最小構成

fine-grained PAT（Sandbox のみ・期限つき）: Contents 読み書き、Pull requests 読み書き、Issues 読み書き、Actions 読み取り、Metadata 読み取り。Workflows の権限は付けない（`.github/workflows` を push できなくなる。望ましい）。

```
package.json            {"name":"sandbox","private":true,"type":"module"}（依存なし）
src/index.js            小さな純関数
test/index.test.js      node:test の試験
.github/workflows/ci.yml
```

`.github/workflows/ci.yml` の要件（collector が機械的に見る）:

- **path** がちょうど `.github/workflows/ci.yml`、**event** が `pull_request`。
- **job の name** が必須段階と同じ `static` `build` `unit` `integration` `e2e` `security` の6つ。無い・skipped・cancelled は不合格。
- run 全体の結論が success であること。

```yaml
name: ci
on: pull_request
permissions:
  contents: read
jobs:
  static:
    name: static
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node --check src/index.js
  build:
    name: build
    # 以下同じ形。build は node --check、unit / integration / e2e は node --test、security は依存なしの確認など
```

推奨: main の保護（GitHub Free の private では使えない場合がある。その場合 PR の merge は人の運用で守る）。Actions は `pull_request` の実行に承認が要らない設定（同じリポジトリの PR なので既定で動く）。

## 9. 実走で確認できたことと、まだ確認できないこと

1件実走（11 章）で確認できたもの:

- CLI が `HTTPS_PROXY` 経由で Anthropic API へ届く（`--dns 127.0.0.1` と `--read-only` の下で）
- CLI の構造化出力と `total_cost_usd` を読み取れる
- fine-grained PAT で git の push、PR の作成と更新、Actions の runs と jobs の読み取りができる
- collector が head SHA に結びつく `pull_request` の run を読み、6 段階の結果を記録する

| まだ確認できないこと                                              | 今の状態                                     |
| ----------------------------------------------------------------- | -------------------------------------------- |
| CI 失敗からの修正（`revising`）、試行の更新と古い PR を閉じる処理 | 実走では通っていない。fake GitHub でのみ確認 |
| 予算到達の停止、`--max-turns` の実動作                            | 実走では到達していない                       |
| CLI の費用の精度と上限超過の幅。Anthropic Console の請求との一致  | 未確認。記録は CLI の申告から換算した値      |
| `--bare` が clone 先の設定を無視するか                            | 未確認。作業場から除くので依存しない         |
| 禁止差分や prompt injection に実 AI が当たったときの動作          | 未確認。作り物の素直な注文書 1 件だけ        |
| GitHub が同じ head の 2 つ目の PR を断る文言（`already exists`）  | 未確認                                       |
| 堅牢化（`ci_incomplete`、PR の後始末、排他、費用の規則）の実走    | 未走。stub docker と fake GitHub でのみ確認  |

## 10. 既知の制限

- worker が push と PR 作成の間や、PR 作成と状態の記録の間でプロセスごと落ちると、そのブランチと PR が残り、次の試行は別のブランチになる。人が閉じる（マーカーの job ID で分かる）。プロセスが生きていて fence が切れた場合は閉じる。
- worker が落ちたまま job が人に取り消された場合、開いたままの試行の割り当ては再開するまで計上されない。
- worker が落ちた後の一時ディレクトリは残る（トークンは含まない。作業ツリーと gitdir のみ）。
- PAT は Actions を読むだけなので、skipped / cancelled の CI を自動で再実行しない。`ci_incomplete` で止まるので、人が再実行してから再開する。再実行せずに再開すると、また止まる。CI の run が1つも現れない場合は待ち続け、`session_limit` で止まる。
- CI の失敗で AI へ渡すのは段階の名前だけ（ログを渡さない）。ログは未信頼の入力になるため今回は渡さない。
- base のイメージ `node:22-bookworm-slim` はタグ固定で digest 固定ではない。CLI は版を固定している。
- プロンプトは argv に載る（ホストの `ps` で見える）。作り物のデータだけなので受け入れている。本番データを入れる前に見直す。

## 11. 1件実走の記録（2026-11-01）

| 項目     | 内容                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| コード   | `auto/devline-real` の `07b1380`                                                                                                                                 |
| DB       | 専用の `mirai_sf_devline`（Staging の DB は使っていない）                                                                                                        |
| 依頼     | 作り物の REQ-2026-0001 版 1                                                                                                                                      |
| 実 Issue | [Sandbox #2](https://github.com/Kensan196948G/Software-Factory-Sandbox/issues/2)                                                                                 |
| 実 PR    | [Sandbox #3](https://github.com/Kensan196948G/Software-Factory-Sandbox/pull/3)、head `a0859c215f808646cff776f11b7cf2615ec4cbb5`。未 merge、人の判断待ち          |
| 独立 CI  | [run 41248964759](https://github.com/Kensan196948G/Software-Factory-Sandbox/actions/runs/41248964759)、6 段階すべて success。head SHA と workflow の path は一致 |
| job      | `pr_ready`、runner `docker-claude`                                                                                                                               |
| 費用     | 20 円（CLI の申告の換算。請求額とは未照合）                                                                                                                      |
| 受入条件 | 未確認の表示（当時は Sandbox に AC と test の対応を報告する仕組みが無かった）。今の判定なら `ci_incomplete` で止まる                                             |
| トークン | 全 repo に届く fine-grained PAT。Sandbox 限定を提案し、範囲の広さを説明したうえで所有者が選んだ。接続先はコードの定数で固定し、コンテナへは渡していない          |

## 12. `pnpm test:docker` の一時的な失敗の調査

記録: flow の 2 件が 4 回中 1 回失敗。当時のログは残っていない（残っている 3 本はすべて成功）。

| 試したこと                                             | 結果                    |
| ------------------------------------------------------ | ----------------------- |
| 統合後のコードで順に 15 回（ファイルは並行のまま）     | 15 回とも成功。再現せず |
| 修正後のコードで結合試験と同時に 10 回（ファイルは順） | 10 回とも成功。再現せず |

再現はしなかったが、失敗の形に合う原因として **Docker の既定のアドレスプールの枯渇** を疑っている（未確定）。このホストのブリッジは 26 本で、既定のプール 31 個のうち 24 個を他のプロジェクトを含めて使っている。runner は 1 回で 2 本（`--internal` も割り当てを使う）、隔離の試験も 2 本作る。当時の失敗は `隔離ネットワークを用意できません`（0 円）で両方の試験が落ちた形と整合するが、以前のコードは stderr を捨てていたので確かめられない。他のプロジェクトの作成を妨げるので、プールを実際に枯渇させる確認はしていない。

行った対策:

- `setUpNetwork` が失敗した段階と stderr の末尾を返し、成果物に残す。実走でも同じ（費用は 0 円）。
- Docker の試験は失敗時に段階・stderr・ブリッジの数を出す。次に起きたら原因が分かる。
- `vitest.docker.config.ts` をファイル順の実行にして、同時に作るネットワークを減らす。

## 13. 画面の投入から実 job へ

runner の種別・対象・トークンはサーバの設定だけで決まる。ブラウザからは指定できない（`orderHandoffSchema` は知らない項目を捨てる。試験で固定）。

| 設定                                | `POST /api/orders/:id/handoff`（と旧ルート）の動き                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVLINE_RUNNER_KIND` なし / `fake` | 従来どおり。`GITHUB_TOKEN` と `GITHUB_REPO` で Issue を作り、job は `fake`                                                              |
| `DEVLINE_RUNNER_KIND=docker-claude` | `DEVLINE_TARGET_REPOS` の1件へ `DEVLINE_GITHUB_TOKEN` で Issue を作り、job は `docker-claude`。`GITHUB_TOKEN` と `GITHUB_REPO` は見ない |
| それ以外の値                        | ERR-405。fake として動かさない                                                                                                          |

実 job の投入を ERR-405 で拒否する場合（fake へ落とさない）: 資格情報のファイルが無い・0600 以外・symlink・他人のもの・`DEVLINE_GITHUB_TOKEN` が無い、`DEVLINE_TARGET_REPOS` が空・`REAL_RUNNER_POLICY.allowedRepos` 以外を含む・repo ID が違う・複数のリポジトリ、公開リポジトリ、`NODE_ENV=production`。

API のプロセスは `DEVLINE_GITHUB_TOKEN` だけを読む。`ANTHROPIC_API_KEY` は worker だけが読む。fake の worker は実 job を取らず、実の worker は fake の job を取らない。worker を動かさなければ job は `queued` のまま。

画面の表示は `job.runnerKind` と証跡で決まる。実 job の「ジョブ」「計画・実装」「自動検査」は、完了していない段階で「実行中」、停止系で「停止」と出し、「実行確認済み」にしない。fake GitHub の結果は `fake` と出す。

**Staging は Approval PR で扱う**: `scripts/setup-preview.mjs` は Staging を `NODE_ENV=production`（`APP_ENV=staging`）にする。`checkRealLineEnv`、`assertRunnerAllowed` は `NODE_ENV=production` の docker-claude を `APP_ENV` に関係なく拒否するので、今の設定のままでは Staging の投入は ERR-405 になり、worker は起動しない。この拒否を緩める変更はこのブランチに含めず、別の Approval PR で扱う。

## 14. 受入条件の証跡（`ac-results`）

CI は同じ run に artifact `ac-results` を残す。zip の中の `.json` はちょうど 1 つ。

```json
{
  "schema": "msf.ac-results/v1",
  "repository": "<owner/name>",
  "runId": "<run の ID>",
  "runAttempt": "<run の attempt>",
  "headSha": "<run の head SHA>",
  "ac": [{ "id": "AC-1", "status": "passed", "testIds": ["AC-1: 空文字なら 0 を返す"] }]
}
```

- `status` は `passed` / `failed` / `not_run`。
- `repository`、`runId`、`runAttempt`、`headSha` がすべて取得元の run と一致するときだけ読む（Sandbox PR #5 の形式。`runId` と `runAttempt` は環境変数から書かれるので文字列で届く）。これらの無い古い形式は、どの run の結果か分からないので `invalid`。artifact の一覧の `workflow_run.id` と `workflow_run.head_sha` も照合する。
- 判定: 全件 `passed`（test ID あり）のときだけ合格。`failed` は `failed`（修正へ）。未確認・欠落・`not_run`・test ID なしは、その AC を `incomplete`。条件が 0 件の注文書も `incomplete`。fake CI の経路も同じ判定。
- 同じ AC の重複と注文書に無い AC は、報告全体を信用しない。全件を未確認にして `incomplete`（`failed` が含まれていても修正へ進めない）。`verdict` の `duplicateAcs` と `unknownAcs` に ID を載せる。
- 「失敗した job だけ再実行」では `ac-results` が前の試行のままなので、`attempt_mismatch` か `missing` で止まる。CI 全体を再実行する。
- PR 本文、AI の申告、runner の結果からは合格を作らない。
- 段階が揃い artifact も読めて AC の試験だけが足りないときは `revising`（再実行では直らないため）。それ以外の実 CI の `incomplete` は `stopped(ci_incomplete)`。`stop_detail` に `cause: 'AC 未確認'`、`unconfirmedAcs`、`acArtifact`（下表）を載せる。

| `acArtifact`          | 意味                                                                          |
| --------------------- | ----------------------------------------------------------------------------- |
| `ok`                  | 読めた（中身に `not_run` などの未確認がある）                                 |
| `missing`             | 同じ run に無い。前の試行のものは使わない                                     |
| `expired`             | 期限切れ                                                                      |
| `too_large`           | 1 MiB を超える（一覧の大きさ、受信の途中、展開後のどれか）                    |
| `duplicate`           | 同じ試行に同じ名前が 2 つ                                                     |
| `head_mismatch`       | 一覧の `workflow_run.head_sha` か JSON の `headSha` が run の head と違う     |
| `invalid`             | zip や JSON の形が違う、古い形式、リダイレクト先が許可されない                |
| `repository_mismatch` | JSON の `repository` が取得元と違う                                           |
| `run_mismatch`        | 一覧の `workflow_run.id` か JSON の `runId` が run と違う（同じ名前の別 run） |
| `attempt_mismatch`    | JSON の `runAttempt` が run の attempt と違う（前の試行の結果）               |
| `duplicate_ac_id`     | 同じ AC ID が複数ある。全件を読まない                                         |
| `unknown_ac_id`       | 注文書に無い AC ID がある。全件を読まない                                     |
| `missing_ac_id`       | 注文書の AC ID が報告に無い。報告のある分は読み、無い分は未確認               |

画面は `acArtifact` が `ok` 以外のとき、ジョブの行に「証跡の欠落（理由）」を出す。

通信の失敗（接続エラーと 5xx）は欠落にしない。記録せず次の工程で読み直す（`delivery` は run ごとに 1 回なので、記録すると固定される）。読めないままなら `session_limit` で止まる。

取得: `GET /repos/{repo}/actions/artifacts/{id}/zip` の 302 を 1 回だけ自分で追う。追う先へ token を送らない。追う先は `GITHUB_API_URL` と同じ規則（https。試験ではループバックだけ）で確かめる。依存は増やしていない（`node:zlib`）。

runner のプロンプトは、試験を `test/unit/` に置き、試験名の先頭を `AC-n:` にするよう伝える。試験を書くのは AI なので、**試験が AC を本当に確かめているかは機械では分からない**。人が PR で確かめる（`docs/limitations.md`）。

migration 0009 の DB ガード（`devline_has_passing_verification`）は `stages` だけを見る。AC の判定はサービス層（`evaluateVerification`）にあり、DB の最後の砦には入っていない。
