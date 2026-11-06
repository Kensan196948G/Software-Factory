# Staging 自動追従の失敗（pnpm 12 のビルド許可）と復旧 — 2026-11-06

作成: 2026-11-06 JST。対象は **Staging の自動追従（`mirai-sf-autofollow.service`）** である。本番は変更していない。秘密・個人情報・接続文字列は書かない。

## 1. 事象

- 2026-11-06 11:50:50 JST、`mirai-sf-autofollow.service` が `action=failed exit=1` で終了した。`c1edde3`（#104 / #105 / #106）への追従が失敗し、**current は `0bb5a799` のまま**（配備はロールバックされ、稼働中の Staging は無傷）。
- 失敗時のログ（要約）:

```
Error: ERR_PNPM_IGNORED_BUILDS
  × installing dependencies
  ╰─▶ Ignored build scripts: esbuild@0.25.12, esbuild@0.28.2, workerd@1.20261023.1
  help: Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
[2026-11-06T02:50:50Z] release.sh が失敗しました（終了コード 1）
[2026-11-06T02:50:50Z] current は元のリリースのままです: 0bb5a799…（status=ok environment=staging db.ok=true commit=0bb5a799…）
```

## 2. 原因

- このホストの pnpm は **12.18.0**（`/usr/bin/pnpm`）。
- pnpm 11 で `onlyBuiltDependencies` / `ignoredBuiltDependencies` が廃止され、**pnpm 12 の `allowBuilds`（`pnpm-workspace.yaml` のマップ）** に置き換わった。`strictDepBuilds` の既定は `true` のため、未承認のビルドスクリプトがあると `pnpm install` は**非ゼロ終了**する。
- リポジトリは `package.json` の `pnpm.onlyBuiltDependencies` だけを持っていたため、pnpm 12 では許可が効かず、`esbuild` / `workerd` のビルドが「未承認」と判定された。
- 09:10 の配備が成功していたのは、その時点では依存の再インストールが実質不要だったため。11:50 は新規 release ディレクトリで `pnpm install --frozen-lockfile` が実行され、この判定に当たった。

## 3. 修正

- `pnpm-workspace.yaml` を追加し、`allowBuilds` に **`esbuild` / `workerd` / `sharp` の 3 つだけ**を `true` で許可した。
- `package.json` の `pnpm.onlyBuiltDependencies` は、pnpm 10 以前を使う環境（CI など）との互換のため残す。**削除しない**。

## 4. 検証（実測）

| 確認 | 結果 |
| ---- | ---- |
| 再現（修正前・空の `node_modules`） | `pnpm install --frozen-lockfile` → `ERR_PNPM_IGNORED_BUILDS`（esbuild 2 版、workerd） |
| 修正後・同一手順 | **成功**（`Done in 1.4s using pnpm v12.18.0`） |
| 既存の `pnpm.onlyBuiltDependencies` のみ | 失敗（上記の再現） |
| 回避策 `--dangerously-allow-all-builds` | 成功するが、**全依存のビルドを無条件に許可するため採用しない** |

- 再現・検証は `/tmp` の隔離ディレクトリで行った（リポジトリと Staging のファイルは変更していない）。
- 検証に使った pnpm は 12.18.0、Node は v22.22.3。

## 5. 復旧手順

1. この修正を main へマージする（CI 3/3 とレビューを通す）。
2. `mirai-sf-autofollow.timer` の次回実行（10 分間隔）を待つ。手動で試す場合は `systemctl --user start mirai-sf-autofollow.service`。
3. `~/.local/state/mirai-sf/autofollow.json` が `action=deployed` になり、`/healthz` の `commit` が新しい main と一致することを確認する。
4. 失敗が続く場合は `journalctl --user -u mirai-sf-autofollow.service -n 60` で原因を確認する。**current は失敗時に元のリリースへ戻る**ため、稼働中の Staging は維持される。

## 6. 再発防止

- pnpm のメジャー更新時に `pnpm-workspace.yaml` の `allowBuilds` と `package.json` の `pnpm.onlyBuiltDependencies` の**両方**を確認する。
- 依存を追加してビルドスクリプトが必要になった場合は、`allowBuilds` に追加し、理由を本書へ追記する（無条件の全許可はしない）。
- 監視: autofollow の失敗は `mirai-sf-onfailure@mirai-sf-autofollow.service.service` が記録する（`~/.local/state/mirai-sf/alerts.jsonl`）。外部通知は未設定（N10 の残課題）。

## 7. 未確認

- GitHub Actions の CI が使う pnpm の版（`package.json` に `packageManager` を置いていないため、ワークフローの設定に依存する）。`allowBuilds` は pnpm 10.26 以降でも解釈されるため、CI への影響は無い見込みだが、**CI の実測で確認する**。
- 本番の release も同じホストの pnpm を使うため、本修正の前に本番 release を実行すると同じ失敗をする。本修正のマージ後に本番配備を行う。
