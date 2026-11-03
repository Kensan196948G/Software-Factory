# 開発ラインの対象リポジトリを増やす（オンボーディング）

状態: 実装済み（許可台帳と `DEVLINE_TARGET_REPOS` の積集合。2026-11-03）。実際に2つ目のリポジトリを載せるには、この手順の 1〜7 をすべて満たす。
対象は**非公開**のリポジトリだけ。公開リポジトリを受ける例外は作らない（注文書に依頼者欄・承認者欄が載るため）。

## 1. 何が「許可」を決めるか

| 層                                    | 場所                                                       | 役割                                                                                 |
| ------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 許可台帳（コードの定数）              | `src/shared/devline.ts` の `DEVLINE_REPO_LEDGER`           | owner/name・repoId・用途・private 前提。ここに無い repo は設定に書いても起動時に拒否 |
| 設定                                  | `DEVLINE_TARGET_REPOS`（`owner/name:repoId` のカンマ区切り） | 実際に有効にする repo。台帳との**積集合**だけが許可される                            |
| 差分 policy（コードの定数）           | `src/shared/devline.ts` の `diffPolicyForRepo` / `SANDBOX_DIFF_POLICY` など | 変更してよい path。定義の無い repo は実 runner に向けない                          |
| job が持つ対象                        | DB の `job.target_repo_id`（と `order_snapshot` / `handoff_intent` の同じ列） | 1つの job は1つの repo に固定。worker と API はこの repo だけを触る                |

- `DEVLINE_TARGET_REPOS` の**先頭が新しい投入の既定先**。複数あってもよい。投入は先頭の repo に行う。
- 2件目以降は、その repo の job が作られた場合に限り、その repo に対してだけ進む。job の repo と設定・台帳が食い違う job は worker が `policy_violation` で止める（取り違えの拒否）。
- どの依頼をどの repo に流すかを画面から選ぶ機能は**まだ無い**（後述の残課題）。

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
4. **設定に足す。** `DEVLINE_TARGET_REPOS=<owner>/<name>:<repoId>`（既存があればカンマで続ける）。先頭を既定の投入先にするなら先頭に置く。**台帳に無い repo を設定に足すと起動が拒否される**（fail-closed）。
5. **資格情報のファイル**（`~/.config/mirai-sf/devline-secrets.env`、0600・本人所有・通常ファイル）に、その repo を読める `DEVLINE_GITHUB_TOKEN` を入れる。値はリポジトリ・チャット・ログに出さない。
6. **dry-run で確認する。** worker を起動し、起動拒否が出ないこと（`pnpm worker` のログ）。`reference` の 1 件実走は `scripts/devline-real-run.ts` で送信なしの dry-run から。
7. **作り物の注文書で1件通す。** 受付番号 `REQ-YYYY-NNNN` の作り物を承認 → 投入 → PR → CI → `pr_ready` まで。画面で次を確かめる。
   - PR の repo が対象 repo である（別の repo の PR が開かれていない）
   - `ac-results` v2 の AC が全件 ○ で、`pr_ready` の根拠になっている
   - job の `targetRepo` が対象 repo である
8. **自動マージを使う場合**（任意）。`docs/devline/real-runner.md` 17章の条件を満たすことを確認してから `DEVLINE_AUTO_MERGE=1` にする。既定は 0（無効）。本番（`APP_ENV=production`）では有効にできない。

## 4. 確認（壊していないこと）

- `pnpm typecheck` / `pnpm lint` / `pnpm test:unit`
- 影響する結合試験（専用の `_test` DB）: `devline-qa-db`（遷移表・制約）、`devline-real`（実 runner の経路）、`devline-auto-merge`
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
| 依頼ごとに投入先 repo を選ぶ方法                               | 画面・API からは選べない（対象はサーバの設定だけ。`orderHandoffSchema` は知らない項目を捨てる） |
| 1つの worker で複数 repo の job を並行に進めるか               | 今は1工程ずつ。`allowedRepos` の全 repo を preflight してから動く                              |
| 2つ目の repo の CI 形式（`ac-results` v2 / `image`）の実装     | 相手 repo 側の作業。形式が違うと `ci_incomplete` / `artifact_missing` で止まる                  |
| 2つ目の repo の main 保護と自動マージの前提                     | 保護が無い間は自動マージを有効にしない（利用者規則）                                            |
| Development-Dispatcher との接続                                | `docs/devline/development-dispatcher-integration.md`（未配備。HTTP 実装はしない）              |
