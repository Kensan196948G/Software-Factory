# 開発ライン 実 AI ランナーと実 PR（docker-claude）

状態: 実装済み。**1件実走の確認済み**（2026-11-01、11 章）。作り物の注文書で `pr_ready` まで到達した。画面の投入は fake のままで、本番と実データには使っていない。
既定は fake のまま。`DEVLINE_RUNNER_KIND=docker-claude` のときだけ動く。

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
- 合否の根拠は Actions の記録だけ（`verification.source='github'`）。AI の申告は使わない。
- CI の失敗は `revising`。修正は直前の head から始め、**試行ごとに新しいブランチと PR** を作る（`auto/<req>-v<版>-a<試行>`）。force push を避けるため。古い PR はマーカーと作成者を確かめて閉じる。差分検査は常に base からの全体で行う。

### 止まる場合

| 条件                                                   | 止まり方                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| 資格情報なし・0600 以外・symlink・他人のファイル       | 起動を拒否（fake へ落とさない）                                   |
| 許可リスト外・定数の repo 以外・repo ID 不一致・public | 起動を拒否。動作中なら `policy_violation`                         |
| `NODE_ENV=production`                                  | 起動を拒否                                                        |
| 禁止差分（4章）                                        | `policy_violation`。push しない                                   |
| 既存の試験の変更・削除・移動                           | `human_approval_required`。push しない                            |
| 予算の到達・CLI が予算で停止                           | `budget_limit`。再開不可                                          |
| workflow が base と別の blob                           | `policy_violation`                                                |
| 結果を受け取れなかった実行（時間切れ・取消・読めない） | 渡した `--max-budget-usd` をまるごと計上（多くは `budget_limit`） |

## 3. 隔離

- コンテナ: `--rm --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --pids-limit --memory --cpus`、実行ユーザーはホストの uid（root では動かさない）。
- bind mount は作業ツリーだけ。**gitdir は作業ツリーの外**に置く（AI が hooks や config を書いても、ホストの git が実行しない）。ホーム・`.ssh`・`.claude` はマウントしない。
- 環境変数は `ANTHROPIC_API_KEY`・`HTTPS_PROXY`・`HTTP_PROXY`・`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`・`DISABLE_AUTOUPDATER` だけ。key は docker の argv に載せない（`--env ANTHROPIC_API_KEY` で引き継ぐ）。GitHub トークンは渡さない。
- 通信: `--internal` かつ `com.docker.network.bridge.inhibit_ipv4=true` のネットワーク（既定の経路なし、ホスト側のブリッジに IP なし）。出口は `deploy/devline/egress-proxy.mjs` の CONNECT だけで、許可先はコードの定数 `api.anthropic.com:443`。`--dns 127.0.0.1` で内蔵 DNS の外への転送先を潰す。
- ホストの git: 環境を空から作り、`GIT_CONFIG_NOSYSTEM`・`GIT_CONFIG_GLOBAL=/dev/null`・`core.hooksPath=/dev/null` など。トークンは fetch / push の子プロセスの `GIT_CONFIG_*`（`http.<origin>/.extraHeader`）だけで、`.git/config` と argv に残さない。リダイレクトを追わない。
- clone 先の `.claude/`・`.mcp.json`・`CLAUDE.md`（深さによらず）は実行前に作業場から除く。`--bare` が無視するかに依存しない。base の内容は commit で保たれる。作り直すと差分検査で拒否する。
- コンテナは名前とラベル（`msf.devline=1`）を持ち、時間切れ・取消で `docker kill`。中でも `timeout --signal=KILL` で切るので worker が落ちても動き続けない。起動時にラベルで残骸を片付ける（**worker は1台の前提**）。
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

戻し方: `docker kill`（ラベル `msf.devline=1`）、Sandbox の PR を閉じてブランチを消す、資格情報のファイルを消してキーとトークンを失効する。工場の DB には `0010` の CHECK の拡張（additive）だけが入る。

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

Sandbox には AC と test ID の対応を報告する仕組みが無いので、PR の受入条件は **未確認** と出る。人が確認する。

推奨: main の保護（GitHub Free の private では使えない場合がある。その場合 PR の merge は人の運用で守る）。Actions は `pull_request` の実行に承認が要らない設定（同じリポジトリの PR なので既定で動く）。

## 9. 実走で確認できたことと、まだ確認できないこと

1件実走（11 章）で確認できたもの:

- CLI が `HTTPS_PROXY` 経由で Anthropic API へ届く（`--dns 127.0.0.1` と `--read-only` の下で）
- CLI の構造化出力と `total_cost_usd` を読み取れる
- fine-grained PAT で git の push、PR の作成と更新、Actions の runs と jobs の読み取りができる
- collector が head SHA に結びつく `pull_request` の run を読み、6 段階の結果を記録する

| まだ確認できないこと                                              | 今の状態                                        |
| ----------------------------------------------------------------- | ----------------------------------------------- |
| CI 失敗からの修正（`revising`）、試行の更新と古い PR を閉じる処理 | 実走では通っていない。fake GitHub でのみ確認    |
| 予算到達の停止、`--max-turns` の実動作                            | 実走では到達していない                          |
| CLI の費用の精度と上限超過の幅。Anthropic Console の請求との一致  | 未確認。記録は CLI の申告から換算した値         |
| `--bare` が clone 先の設定を無視するか                            | 未確認。作業場から除くので依存しない            |
| 禁止差分や prompt injection に実 AI が当たったときの動作          | 未確認。作り物の素直な注文書 1 件だけ           |
| GitHub が同じ head の 2 つ目の PR を断る文言（`already exists`）  | 未確認                                          |
| `pnpm test:docker` の一時的な失敗（flow の 2 件、4 回中 1 回）    | 原因は未特定。再実行で成功。CI には入っていない |

## 10. 既知の制限

- **実 job を作るのは1件実走の入口だけ**。画面の投入は fake のまま（API は `GITHUB_TOKEN` を使うので、許可なく切り替えない）。
- worker が push と PR 作成の間や、PR 作成と状態の記録の間で落ちると、そのブランチと PR が残り、次の試行は別のブランチになる。人が閉じる（マーカーの job ID で分かる）。
- worker が落ちた後の一時ディレクトリは残る（トークンは含まない。作業ツリーと gitdir のみ）。
- PAT は Actions を読むだけなので、skipped / cancelled の CI を自動で再実行しない。人が再実行するか、`session_limit` で止まる。
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
| 受入条件 | 未確認の表示（Sandbox に AC と test の対応を報告する仕組みが無いため）。人が確認する                                                                             |
| トークン | 全 repo に届く fine-grained PAT。Sandbox 限定を提案し、範囲の広さを説明したうえで所有者が選んだ。接続先はコードの定数で固定し、コンテナへは渡していない          |
