#!/usr/bin/env bash
# CI ワークフローを人間の操作で適用するためのスクリプト。
#
# 背景: エージェントの自己進化ポリシーゲートは `.github/workflows/` を
#       DEPLOY（critical）として拒否するため、このコピー作業だけは人間が実行する。
#       スクリプトは「コピー → ブランチ → コミット → push → PR作成」まで行う。
#
# 使い方:
#   bash scripts/apply-ci.sh --check   # 前提確認と実行内容の表示（何も変更しない）
#   bash scripts/apply-ci.sh           # 適用（要: クリーンな main）
#
# 実行後: 表示されたPR URLで CI が走る。エージェントに「1」と伝えれば、
#         CI監視・失敗修正・Squash Merge まで自動で行う。
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="docs/patches/ci.workflow.yml"
DST=".github/workflows/ci.yml"
BRANCH="auto/ci-workflow"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

fail() { echo "NG  $1" >&2; exit 1; }
ok() { echo "OK  $1"; }

# ── 前提確認 ───────────────────────────────────────────────
[ -f "$SRC" ] || fail "$SRC がありません"
ok "コピー元: $SRC ($(wc -c < "$SRC") bytes)"

if [ -f "$DST" ]; then
  if cmp -s "$SRC" "$DST"; then
    echo "既に適用済みです（内容一致）: $DST"
    exit 0
  fi
  fail "$DST が既に存在し、内容が異なります。手動で確認してください"
fi

CURRENT=$(git branch --show-current)
[ "$CURRENT" = "main" ] || fail "main ブランチで実行してください（現在: $CURRENT）"
ok "ブランチ: main"

if [ -n "$(git status --porcelain)" ]; then
  fail "作業ツリーに未コミットの変更があります。commit か stash の後に実行してください"
fi
ok "作業ツリー: clean"

git fetch origin --quiet || fail "git fetch に失敗しました"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] || fail "main が origin/main と一致しません（local=$LOCAL remote=$REMOTE）。git pull してください"
ok "main = origin/main ($LOCAL)"

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  fail "ローカルブランチ $BRANCH が既に存在します"
fi
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  fail "リモートブランチ $BRANCH が既に存在します"
fi
ok "ブランチ $BRANCH は未使用"

command -v gh >/dev/null || fail "gh コマンドが見つかりません"
gh auth status >/dev/null 2>&1 || fail "gh が未ログインです"
ok "gh ログイン済み"

echo
echo "実行内容:"
echo "  1) $SRC を $DST へコピー"
echo "  2) ブランチ $BRANCH を作成してコミット"
echo "  3) origin へ push"
echo "  4) main 向けの PR を作成（CI が起動）"
echo

if [ "$CHECK" = "1" ]; then
  echo "チェックのみ（変更していません）。適用するには --check を外して実行してください。"
  exit 0
fi

# ── 適用 ───────────────────────────────────────────────────
git checkout -b "$BRANCH" >/dev/null
mkdir -p .github/workflows
cp "$SRC" "$DST"
git add "$DST"
git commit -q -m "ci: 品質ゲート（型・Lint・テスト・migration・ビルド・秘密スキャン）を追加"
git push -u origin "$BRANCH" >/dev/null

BODY="## 目的
CI を有効化し、PR と main で品質ゲートを実行する。

## 内容
- Node 22 / pnpm 10 / PostgreSQL 16 service
- typecheck → lint → unit → migration（2回・冪等）→ seed → db:verify → integration → build → secret scan

## 背景
エージェントの自己進化ポリシーゲートが \`.github/workflows/\` を DEPLOY（critical）として拒否するため、人間の操作で適用した。

## テスト
適用後に本PRの CI で実測する。"
PR_URL=$(gh pr create --base main --head "$BRANCH" \
  --title "ci: 品質ゲートを追加（typecheck/lint/test/migration/build/secret scan）" \
  --body "$BODY" 2>/dev/null | tail -1)

echo
echo "PR を作成しました: $PR_URL"
echo "CI の完了後、エージェントに「1」と伝えてください（監視・修正・マージを自動で行います）。"
