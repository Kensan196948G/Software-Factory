# 人間の適用が必要なパッチ（policy gate）

DeepSeek Harness の自己進化ポリシーゲートにより、エージェントは `.github/workflows/` と
本番配備系の設定ファイルを直接作成できない（`DEPLOY is critical risk` として拒否される）。
迂回は行わず、ここに適用用のファイルを置く。

## 1. CI ワークフロー（かんたん適用）

**人間の操作は次の1コマンドだけ**です（リポジトリの main で実行）。

```bash
cd /mnt/storage/Software-Factory/Software-Factory
bash scripts/apply-ci.sh --check   # 前提確認（任意・変更なし）
bash scripts/apply-ci.sh           # コピー → ブランチ → commit → push → PR作成
```

スクリプトが行うこと:

1. `docs/patches/ci.workflow.yml` を `.github/workflows/ci.yml` へコピー
2. `auto/ci-workflow` ブランチを作成してコミット
3. origin へ push
4. main 向けの PR を作成（CI が起動）

実行後、表示された PR URL をエージェントに伝えれば、**CI監視・失敗修正・Squash Merge** まで自動で行う。

前提（スクリプトが確認します）:
- main ブランチで実行している
- 作業ツリーが clean
- local main が origin/main と一致
- `.github/workflows/ci.yml` と `auto/ci-workflow` が未作成

## 2. 手動で適用する場合

```bash
git checkout main && git pull --ff-only
git checkout -b auto/ci-workflow
mkdir -p .github/workflows
cp docs/patches/ci.workflow.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "ci: 品質ゲートを追加"
git push -u origin auto/ci-workflow
gh pr create --base main --head auto/ci-workflow \
  --title "ci: 品質ゲートを追加" \
  --body "CI を有効化します。"
```

## 3. 内容

- Node 22 / pnpm 10 / PostgreSQL 16 service（`mirai_sf_test`）
- typecheck → lint → unit → migration（2回・冪等）→ seed → db:verify → integration → build → secret scan
- ローカルで同一手順を実行済み（`docs/test.md`）

## 4. 未適用の理由（記録）

- 2026-10-28: `write` ツールが `self-evolution policy gate: DEPLOY is critical risk` で拒否。
- 代替: ローカルで同一手順を実行し、結果を `docs/test.md` に記録する。
- 再開条件: 人間が上記ファイルを適用する、またはポリシーのリスク区分が見直される。
