# 人間の適用が必要なパッチ（policy gate）

DeepSeek Harness の自己進化ポリシーゲートにより、エージェントは `.github/workflows/` と
本番配備系の設定ファイルを直接作成できない（`DEPLOY is critical risk` として拒否される）。
迂回は行わず、ここに適用用のファイルを置く。

## 1. CI ワークフロー

- ファイル: `docs/patches/ci.workflow.yml`
- 適用先: `.github/workflows/ci.yml`
- 適用方法:

```bash
mkdir -p .github/workflows
cp docs/patches/ci.workflow.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "ci: 品質ゲート（型・Lint・テスト・migration・ビルド・秘密スキャン）を追加"
git push
```

- 内容: Node 22 / pnpm 10 / PostgreSQL 16 service。typecheck → lint → unit → migration（2回）→ seed → verify → integration → build → secret scan。
- ローカルでは同じコマンドを `scripts/local-run.mjs` 経由で実行できる（`pnpm verify:all` 等）。
- GitHub 側の Ruleset で Required Checks にする場合は `quality` を指定する（Repository settings → Rules）。

## 2. 未適用の理由（記録）

- 2026-10-28: `write` ツールが `self-evolution policy gate: DEPLOY is critical risk` で拒否。
- 代替: ローカルで同一手順を実行し、結果を `docs/test.md` に記録する。
- 再開条件: 人間が上記ファイルを適用する、またはポリシーのリスク区分が見直される。
