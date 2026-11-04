# 開発ラインの対象リポジトリを増やす（オンボーディング）

状態: 実装済み（許可台帳と `DEVLINE_TARGET_REPOS` の積集合。2026-11-03）。実際に2つ目のリポジトリを載せるには、この手順の 1〜7 をすべて満たす。
対象は**非公開**のリポジトリだけ。公開リポジトリを受ける例外は作らない（注文書に依頼者欄・承認者欄が載るため）。
2026-11-04 追記: 投入先を選んだ**直後**に前提を1コマンドで検査する `scripts/ops/repo-onboarding-check.mjs`（`pnpm ops:repo-check`）を追加した。読取り専用で、PASS / FAIL / UNKNOWN を表と JSON で返す（7〜11章）。選ぶのは人間のまま。

## 1. 何が「許可」を決めるか

| 層                                    | 場所                                                       | 役割                                                                                 |
| ------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 許可台帳（コードの定数）              | `src/shared/devline.ts` の `DEVLINE_REPO_LEDGER`           | owner/name・repoId・用途・private 前提。ここに無い repo は設定に書いても起動時に拒否 |
| 設定                                  | `DEVLINE_TARGET_REPOS`（`owner/name:repoId` のカンマ区切り） | 実際に有効にする repo。台帳との**積集合**だけが許可される                            |
| 差分 policy（コードの定数）           | `src/shared/devline.ts` の `diffPolicyForRepo` / `SANDBOX_DIFF_POLICY` など | 変更してよい path。定義の無い repo は実 runner に向けない                          |
| job が持つ対象                        | DB の `job.target_repo_id`（と `order_snapshot` / `handoff_intent` の同じ列） | 1つの job は1つの repo に固定。worker と API はこの repo だけを触る                |

- `DEVLINE_TARGET_REPOS` の**先頭が新しい投入の既定先**。複数あってもよい。投入は先頭の repo に行う。
- 2件目以降は、その repo の job が作られた場合に限り、その repo に対してだけ進む。job の repo と設定・台帳が食い違う job は worker が `policy_violation` で止める（取り違えの拒否）。
- どの依頼をどの repo に流すかは**依頼ごとに選べる**（2026-11-04・L-12）。依頼の `target_repo_id`（`owner/name`）に、設定と台帳の積集合に載っている repo だけを保存できる。未指定は先頭。画面は依頼の詳細の「開発ライン」欄の「投入先」で選ぶ（`PATCH /api/requests/:id/devline-target`）。作成・更新の API でも `targetRepoId` を受ける（積集合の外は ERR-405）。

## 2. 前提（すべて満たすこと）

| 前提                       | 確認方法 / 要件                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 非公開リポジトリ           | GitHub の Settings で private。サーバも投入の前に API で `private` を確認する                                                                                                                                    |
| CI が同じ run に合格を出す | `.github/workflows/ci.yml`、event `pull_request`、job 名が `static` `build` `unit` `integration` `e2e` `security` の6つ。skip / cancelled は不合格。run 全体が success |
| `ac-results` artifact（v2） | 同じ run に artifact 名 `ac-results`。zip 内の `.json` は1つで、`schema: "msf.ac-results/v2"`。`repository` `runId` `runAttempt` `headSha` が run と一致。各 AC は `requestId`（`REQ-YYYY-NNNN`）か `orderHash`、`testFile`（`test/` または `tests/` の下、その PR の変更ファイル）を持つ |
| `image` artifact（配備する場合） | 同じ run に artifact 名 `image`。`msf.image/v1` の meta と `image.tar`。配備の承認まで行うなら必要                                                                                                                                 |
| repoId                     | `gh api repos/<owner>/<name> --jq .id` の数値。名前の付け替え・譲渡の検出に使う                                                                                                                                  |
| トークンの範囲             | `DEVLINE_GITHUB_TOKEN` は対象 repo の Contents / Pull requests / Issues / Actions（読み） / Metadata（読み）。Workflows の権限は付けない                                                                         |
| 差分 policy                | その repo で AI に触らせてよい path を `RepoDiffPolicy` で定義する。テストの保護（`protectedTestPrefixes`）も決める                                                                                              |
| main の保護（推奨）        | 必須チェックと直接 push の禁止。保護が無い間は自動マージを有効にしない（`docs/devline/assessment/branch-protection-proposal.md`）                                                                                |

## 3. 手順

1. **repoId を控える。** `gh api repos/<owner>/<name> --jq .id`。名前は `owner/name` の完全一致で書く。
2. **差分 policy を追加する。** `src/shared/devline.ts` に `RepoDiffPolicy` を作り、`REPO_DIFF_POLICIES` に登録する。少なくとも `version`、`allowedPrefixes`、`forbidden`、`protectedTestPrefixes`、`maxFiles` を決める。迷ったら Sandbox の `SANDBOX_DIFF_POLICY` を狭くした形から始める。
3. **許可台帳に1行足す。**
   ```ts
   {
     name: '<owner>/<name>',
     repoId: '<数値>',
     purpose: '<何のために許すか（監査と docs に出す）>',
     private: true,
   }
   ```
4. **設定に足す。** `DEVLINE_TARGET_REPOS=<owner>/<name>:<repoId>`（既存があればカンマで続ける）。先頭を既定の投入先にするなら先頭に置く。**台帳に無い repo を設定に足すと起動が拒否される**（fail-closed）。2件目以降を足すと、依頼ごとに選べる候補になる（画面の「投入先」）。
5. **資格情報のファイル**（`~/.config/mirai-sf/devline-secrets.env`、0600・本人所有・通常ファイル）に、その repo を読める `DEVLINE_GITHUB_TOKEN` を入れる。値はリポジトリ・チャット・ログに出さない。
6. **dry-run で確認する。** worker を起動し、起動拒否が出ないこと（`pnpm worker` のログ）。`reference` の 1 件実走は `scripts/devline-real-run.ts` で送信なしの dry-run から。
7. **作り物の注文書で1件通す。** 受付番号 `REQ-YYYY-NNNN` の作り物を承認 → 投入 → PR → CI → `pr_ready` まで。画面で次を確かめる。
   - PR の repo が対象 repo である（別の repo の PR が開かれていない）
   - `ac-results` v2 の AC が全件 ○ で、`pr_ready` の根拠になっている
   - job の `targetRepo` が対象 repo である
8. **自動マージを使う場合**（任意）。`docs/devline/real-runner.md` 17章の条件を満たすことを確認してから `DEVLINE_AUTO_MERGE=1` にする。既定は 0（無効）。本番（`APP_ENV=production`）では有効にできない。

## 4. 確認（壊していないこと）

- `pnpm typecheck` / `pnpm lint` / `pnpm test:unit`
- 影響する結合試験（専用の `_test` DB）: `devline-qa-db`（遷移表・制約）、`devline-real`（実 runner の経路）、`devline-auto-merge`、`devline-target-selection`（依頼ごとの投入先の受理・拒否・後方互換）
- 1件実走の記録は `docs/devline/real-runner.md` の 11章・16章と同じ形で残す（repo、受付番号、PR、head、run、AC、merge、配備、戻し）。

## 5. 戻し方

1. 先に **設定から外す**（`DEVLINE_TARGET_REPOS` を元に戻して worker を再起動）。以降の投入はその repo に行かない。
2. 動いている job が無いことを確認してから、台帳の行と差分 policy を消す（コード変更）。
3. 開いている PR は、マーカー（job ID）と作成者を確かめて人が閉じる。自動では消さない。
4. `DEVLINE_AUTO_MERGE` を有効にしていたなら 0 に戻す（自動マージの契機が無くなる）。
5. トークンを失効・再発行する場合は、資格情報のファイルを更新してから worker を再起動する。

## 6. 残課題（2つ目を実際に載せる前に決めること）

| 残課題                                                         | 今の状態                                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 依頼ごとに投入先 repo を選ぶ方法                               | **解消（2026-11-04）**。`request.target_repo_id` と作成・更新の `targetRepoId`、`PATCH /api/requests/:id/devline-target`。値はサーバが積集合で検証する（`orderHandoffSchema` は従来どおり本文の repo を捨てる） |
| 1つの worker で複数 repo の job を並行に進めるか               | 今は1工程ずつ。`allowedRepos` の全 repo を preflight してから動く                              |
| 2つ目の repo の CI 形式（`ac-results` v2 / `image`）の実装     | 相手 repo 側の作業。形式が違うと `ci_incomplete` / `artifact_missing` で止まる                  |
| 2つ目の repo の main 保護と自動マージの前提                     | 保護が無い間は自動マージを有効にしない（利用者規則）                                            |
| Development-Dispatcher との接続                                | `docs/devline/development-dispatcher-integration.md`（未配備。HTTP 実装はしない）              |

## 7. 候補の選び方（人間が決める）

「どれを2つ目にするか」はスクリプトでは決めない（所有者の判断）。決めたら 8章の1コマンドで前提を確かめ、足りない点を 10章の対処で埋める。

| 観点                                  | 必要条件                                                                               | 理由・だれが用意するか                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 非公開（private）                     | **必須**。`private: true`                                                              | 注文書 YAML に依頼者欄・承認者欄が載る（L-14）。公開は例外なしで ERR-405               |
| archived でない                       | **必須**                                                                               | アーカイブは読取り専用で PR を作れない                                                 |
| 既定ブランチとその保護                | **必須**。既定ブランチに required_status_checks がある                                 | 保護が無い間は `DEVLINE_AUTO_MERGE` を有効にしない（L-15）。設定は repo の管理者       |
| `.github/workflows/ci.yml`            | **必須**。active で、`pull_request` で動く                                             | run 全体が success したことを根拠にする（2章）。相手 repo 側の作業                     |
| artifact `ac-results`（同じ run・v2） | **必須**。形式は `msf.ac-results/v2`                                                   | 合格の根拠。形式が違うと `ci_incomplete` / `artifact_missing` で止まる（相手 repo 側） |
| artifact `image`（v1）                | 配備まで行うなら必須                                                                   | 配備の承認まで進める場合だけ（2章）                                                    |
| 差分 policy を書ける                  | **必須**。`src/shared/devline.ts` の `RepoDiffPolicy` を `REPO_DIFF_POLICIES` に足せる | 定義の無い repo は実 runner に向かない（SF 側。11章）                                  |
| トークンの範囲                        | その repo の Contents / Pull requests / Issues / Actions（読み）/ Metadata（読み）     | `DEVLINE_GITHUB_TOKEN`。Workflows の権限は付けない（2章）                              |
| 誰が CI を用意するか                  | 相手 repo 側                                                                           | SF は相手の CI を代わりに作らない（PR を送るのは注文書の実行だけ）                     |

- **候補にしない repo**: 役割が逆のもの（`Development-Dispatcher` は SF に仕事を投げる側）、上位の制御（`AI-Company-Control-Center`）、アーカイブ済み、公開。
- 2026-11-04 時点の実測（private 33 件）は `docs/devline/assessment/2026-11-04-repo-onboarding-candidates.md`。`ac-results` があるのは `Software-Factory-Sandbox` だけで、その repo も必須チェックが無い（＝今すぐ全項目 PASS の repo は無い）。

## 8. 検証（1コマンドで前提を確かめる）

```bash
pnpm ops:repo-check Kensan196948G/<name>          # 人向けの表（PASS / FAIL / UNKNOWN）
pnpm ops:repo-check Kensan196948G/<name> --json   # 機械可読（CI から使う）
node scripts/ops/repo-onboarding-check.mjs --help  # 使い方と PASS 条件
```

- 実体は `scripts/ops/repo-onboarding-check.mjs`（Node 22・依存追加なし）。`gh` を `node:child_process` から呼ぶ。
- **読取り専用**: `gh api` の GET だけ。PR も設定も作らない。artifact の**中身は落とさない**（名前と存在だけ）。
- 前提: `gh auth status` が通り、そのアカウントが対象 repo を読めること（private は権限が無いと 404 になる）。
- 終了コード: **0=PASS / 1=FAIL あり / 2=UNKNOWN あり（FAIL は無い）/ 64=使い方の誤り**。CI では 2 を「判定不能」として扱い、PASS と混ぜない。
- 実測例（2026-11-04・`Kensan196948G/Development-Dispatcher`）:

```
状態     検査               結果
PASS     repository         id=1440366462
PASS     private            非公開（visibility=PRIVATE）
PASS     archived           アーカイブされていない
PASS     default_branch     main
FAIL     required_checks    main が保護されていない（必須チェックが無い。自動マージの前提を満たさない）
PASS     ci_workflow        .github/workflows/ci.yml（id=402379532）
FAIL     latest_ci          run 41687537688（34b51db） が failure。success でない job: api(failure)
FAIL     ac_results         ac-results が無い（CI で artifact 名 ac-results を出す）
```

## 9. PASS の条件（検査ごと）

| 検査              | PASS の条件                                                          | FAIL の意味                                                       | UNKNOWN になる場面                          |
| ----------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| `repository`      | `gh api repos/<owner>/<name>` が返る                                 | 404（無い、または gh のアカウントが読めない）                     | 認証・権限・ネットワーク・gh 不在・時間切れ |
| `private`         | `private: true`（visibility が PRIVATE）                             | 公開（L-14 により投入できない）                                   | －                                          |
| `archived`        | `archived: false`                                                    | アーカイブ済み（読取り専用）                                      | －                                          |
| `default_branch`  | 既定ブランチ名がある                                                 | 既定ブランチが無い（空のリポジトリ等）                            | －                                          |
| `required_checks` | 保護に required_status_checks が1件以上                              | 保護が無い／必須チェックが無い／保護を取得できない（404）         | 保護の読取りが拒否された（403）等           |
| `ci_workflow`     | `.github/workflows/ci.yml`（または `ci.yaml`）が active              | ci.yml が無い／有効な workflow が無い                             | workflow 一覧を読めない                     |
| `latest_ci`       | 直近の `pull_request` の run が success で、job が**すべて** success | run が failure / cancelled、success でない job がある、実行が無い | run や job を読めない                       |
| `ac_results`      | 直近の CI の run に `ac-results` がある（期限切れでない）            | 無い／期限切れだけ／別の run にしか無い                           | 存在するが直近の run と突き合わせられない   |

- 総合判定: FAIL が1つでもあれば FAIL（exit 1）。FAIL が無く UNKNOWN があれば UNKNOWN（exit 2）。全部 PASS のときだけ PASS（exit 0）。
- **最終 push 日時は判定に使わない**（表示だけ。古い repo を弾く規則はまだ無い）。
- `ac-results` の**中身は判定しない**。v2 の一致性（`runId`・`headSha`・AC の `testFile`）は実 runner の検証で確かめる（`docs/devline/real-runner.md`）。このツールの PASS は「名前と存在」までで、v2 であることの証明ではない。
- `skip` / `cancelled` は不合格（`continue-on-error` や条件付き実行で job を飛ばすと `latest_ci` が FAIL になる）。
- 検査するのは**既定ブランチ**（`main` など）。既定ブランチが `feat/...` の repo は、そのブランチを対象にする。

## 10. FAIL したときの対処

| 検査              | 対処                                                                                                                              | だれが             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `repository`      | `owner/name` の綴りを確認する。404 が続くなら、その repo を読めるアカウントか（`gh auth status`）を確認する                       | 実行者             |
| `private`         | 別の repo を選ぶ。公開のまま使う例外は作らない（L-14）                                                                            | 所有者             |
| `archived`        | 別の repo を選ぶ（アーカイブは解除しない）                                                                                        | 所有者             |
| `default_branch`  | 空のリポジトリなら最初の push を行う                                                                                              | 相手 repo          |
| `required_checks` | repo の Settings → Branches で既定ブランチを保護し、必須チェックを CI の job 名で指定する。保護が無い間は自動マージを有効にしない | 相手 repo の管理者 |
| `ci_workflow`     | `.github/workflows/ci.yml` を用意し、`pull_request` で動かす                                                                      | 相手 repo          |
| `latest_ci`       | 直近の `pull_request` の CI を緑にする。skip / cancelled を出さない                                                               | 相手 repo          |
| `ac_results`      | 同じ run に artifact 名 `ac-results` を v2 形式で出す。保持期限（既定90日）切れに注意                                             | 相手 repo          |
| `UNKNOWN`         | 表示の理由を解消してから再実行する（権限・レート制限・gh のログイン・ネットワーク）。**UNKNOWN を PASS として扱わない**           | 実行者             |

## 11. 台帳と設定への追加（コードの場所と変更例）

### 11-1. 許可台帳 `DEVLINE_REPO_LEDGER`（コードの定数）

- 場所: `src/shared/devline.ts` の `DEVLINE_REPO_LEDGER`（2026-11-04 時点で 858 行目付近）。**環境変数ではない**。
- 台帳に無い repo は、設定に書いても起動時に拒否される（fail-closed）。
- 変更例（既存の Sandbox の行の後ろに1行足す）:

```ts
export const DEVLINE_REPO_LEDGER: readonly RepoAllowEntry[] = [
  {
    name: SANDBOX_REPO.name,
    repoId: SANDBOX_REPO.repoId,
    purpose: '開発ラインの検証用 Sandbox（作り物の注文書だけを流し、CI が ac-results と image を出す）',
    private: true,
  },
  {
    name: 'Kensan196948G/Example-Repo',
    repoId: '1234567890',
    purpose: '2つ目の投入先（作り物の注文書だけを流す）',
    private: true,
  },
];
```

- `repoId` は `gh api repos/<owner>/<name> --jq .id` の**数値**（文字列で持つ）。名前の付け替え・譲渡の検出に使う（3章の手順1）。

### 11-2. 差分 policy

`src/shared/devline.ts` に `RepoDiffPolicy` を作り、`REPO_DIFF_POLICIES` に登録する（3章の手順2）。定義が無い repo は実 runner へ向かない。

### 11-3. 設定 `DEVLINE_TARGET_REPOS`

- 形: `owner/name:repoId` のカンマ区切り。**先頭が新しい投入の既定先**。
- 置き場所（このホストで実際に読まれるファイル。2026-11-04 実測）:

| 環境     | ファイル                                  | 読む側                                                                     | 実測（キーの有無と空否だけ。値は見ていない）             |
| -------- | ----------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| Staging  | `~/.config/mirai-sf/preview.conf`（0600） | `mirai-sf-worker.service` の `EnvironmentFile`、`scripts/ops/with-env.mjs` | **設定済み・非空（1件）**                                |
| 本番     | `~/.config/mirai-sf/prod.conf`（0600）    | `scripts/ops/prod-*.sh` が `MIRAI_SF_ENV_FILE` として渡す                  | **キーが無い＝未設定**（本番の新規投入はすべて ERR-405） |
| ローカル | `~/.config/mirai-sf/local.json`           | `scripts/local-run.mjs`                                                    | **キーが無い**                                           |

- **本番は未設定**である（`prod.conf` に `DEVLINE_TARGET_REPOS` が無い）。これは意図した fail-closed で、本番で使うには値の追加と worker の再起動が要る。このリポジトリの手順では本番の設定を変えない（所有者の判断）。
- 値をリポジトリ・PR・ログ・チャットに書かない（owner/name と repoId は秘密ではないが、設定ファイルの値を出さない運用に揃える）。

### 11-4. 追加の順序と確認

1. 台帳に1行（11-1）→ 2. 差分 policy（11-2）→ 3. 設定に追加（11-3。既存があるならカンマで続ける）→ 4. worker を再起動し、起動拒否が出ないこと（`pnpm worker` のログ）→ 5. `pnpm ops:repo-check <owner/name>` で前提を再確認 → 6. 依頼の詳細で投入先を選べる（L-12）。
2. 戻すときは 5章の順序（先に設定から外す → 動いている job を確認 → 台帳と policy を消す）。

## 12. 実測（2026-11-04）: 候補の比較表

- 一覧: `docs/devline/assessment/2026-11-04-repo-onboarding-candidates.md`（private 33 件・public 34 件・archived 1 件の実測。`gh repo list --limit 100` は 67 件を返し打ち切りなし）。
- 要点: `.github/workflows/ci.yml` があるのは private 33 件中 31 件、required_status_checks があるのは 8 件、artifact `ac-results` があるのは `Software-Factory-Sandbox` の1件だけ。**今すぐ全項目 PASS の repo は無い**（Sandbox も必須チェックが無い）。
- 表は 2026-11-04 時点の実測。台帳・設定を変える前に、対象 `<name>` を指定して `pnpm ops:repo-check` で再検査する。
