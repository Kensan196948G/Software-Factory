# Staging 自動追従の失敗（pnpm 12 のビルド許可）と復旧 — 2026-11-06

作成: 2026-11-06 JST。対象は **Staging の自動追従（`mirai-sf-autofollow.service`）** である。本番は変更していない。秘密・個人情報・接続文字列は書かない。

## 1. 事象

- 2026-11-06 **11:40:42 JST に初回の失敗**、**11:50:50 JST にも失敗**し、`mirai-sf-autofollow.service` が `action=failed exit=1` で終了した。`c1edde3`（#104 / #105 / #106）への追従が失敗し、**current は `0bb5a799` のまま**（配備はロールバックされ、稼働中の Staging は無傷）。
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

- `/usr/bin/pnpm` は **corepack のシム**で、実際の pnpm の版は実行時に解決される。2026-11-06 の実測では、**09:10 の配備は pnpm 10.26.2 で成功**し、**11:40 に corepack の `lastKnownGood.json` が 12.18.0 に更新**された後（12.18.0 のキャッシュ生成も 11:40）、**11:40:42 の実行から失敗**した。11:50:50 の失敗も同じ版で起きている。
- pnpm 11 で `onlyBuiltDependencies` / `ignoredBuiltDependencies` が廃止され、**`allowBuilds`（`pnpm-workspace.yaml` のマップ）** に置き換わった（pnpm 11 の実機は未確認。pnpm 12.18.0 と 10.33.2 で実測）。`strictDepBuilds` の既定は `true` のため、未承認のビルドスクリプトがあると `pnpm install` は**非ゼロ終了**する。
- リポジトリは `package.json` の `pnpm.onlyBuiltDependencies` だけを持っていたため、pnpm 12 はこれを**無視**し（`The 'pnpm' field … ignored "pnpm.onlyBuiltDependencies"` の警告）、`esbuild` / `workerd` のビルドが「未承認」と判定された。
- **構造的な原因**: `package.json` に `packageManager` が無く、ホストの corepack の既定が変わると pnpm の版が変わる。版が固定されていないため、同一手順が前日/前回は通り、ある時点から通らなくなる。

## 3. 修正

- `pnpm-workspace.yaml` を追加し、`allowBuilds` に **`esbuild` / `workerd` / `sharp` の 3 つだけ**を `true` で許可した。
- `package.json` の `pnpm.onlyBuiltDependencies` は、pnpm 10 以前を使う環境との互換のため残す。**削除しない**（現在の CI は 12.18.0 で、こちらは無視される）。

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
- **版の固定（2026-11-06 に判断）**: `package.json` の `packageManager` は**採用しない**。pnpm 12 では `packageManager` を書くと pnpm 自身が依存として lockfile に追加され（`packageManagerDependencies` + `@pnpm/exe.*`）、lockfile が二重ドキュメント構造になる。`allowBuilds` の追加だけで pnpm 10 / 12 の両方が install に成功することを実測したため、まずはそれで足りる。
- **CI を pnpm 12 に合わせる（2026-11-06 実施）**: `.github/workflows/ci.yml` の `pnpm/action-setup` の `version` を 10 → **12.18.0** に変更し、デプロイと同じ版で CI を回す。PR の CI（quality / docker は pnpm 12.18.0 で成功）で検証した。
- **残る非対称**: ホストの pnpm は corepack の `lastKnownGood` 依存で、まだ固定されていない。将来 12.19 / 13 に上がると CI の 12.18.0 と再び乖離する。`packageManager` を採用しない判断の帰結として、ホスト側の版を上げる際は CI の `version` も同時に更新する（`docs/production/02-runbook.md` の手順 0 で版を確認する）。
- 監視: autofollow の失敗は `mirai-sf-onfailure@mirai-sf-autofollow.service.service` が記録する（`~/.local/state/mirai-sf/alerts.jsonl`）。外部通知は未設定（N10 の残課題）。

## 7. 未確認

- pnpm 11 の実機での挙動（本ホストには無い）。pnpm 12.18.0 と 10.33.2 では実測済み。
- 本番の release も同じホストの corepack の pnpm を使うため、本修正の前に本番 release を実行すると同じ失敗をする。本修正のマージ後に本番配備を行う。
- 11:40:42 の初回失敗の時点で、他に同時実行された release があったか（journal では確認していない）。

### 7-1. CI の pnpm 版（確認済み）

- `.github/workflows/ci.yml` は `pnpm/action-setup` で `version: 12.18.0` を明示している（2026-11-06 に 10 から変更）。デプロイ環境と同じ版で CI を回すため、今回の失敗クラス（pnpm 12 で未承認ビルド）をマージ前に検知できる。
- `allowBuilds` は pnpm 10.26 以降でも解釈される（担当が 10.33.2 で実測）。したがって CI を 10 に戻しても install は通る。
- 残る課題: `docs/patches/ci.workflow.yml`（CI ブートストラップ用の旧コピー）は `version: 10` のまま。`scripts/apply-ci.sh` は `ci.yml` が無いときだけコピーするため実害は限定的だが、次に触るときに揃える。
