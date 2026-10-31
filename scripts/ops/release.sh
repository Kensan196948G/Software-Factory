#!/usr/bin/env bash
# main に含まれる commit を固定リリースとして展開し、切り替える。
#
#   scripts/ops/release.sh [--dry-run] [--no-restart] <commit-sha>
#
#   --dry-run     検査と計画の表示だけ（ファイル・DB・サービスを変更しない）
#   --no-restart  current の切替までで止める（初回の切替で unit を入れ替える前に使う）
#
# 手順: main 確認 → git archive → pnpm install/build → 事前バックアップ → migration
#       → current 切替 → API 再起動 → /healthz の commit 確認（失敗時は前のリリースへ戻す）
#
# 環境変数:
#   MIRAI_SF_HOME          既定 ~/.local/share/mirai-sf（releases/ と current を置く）
#   MIRAI_SF_ENV_FILE      既定 ~/.config/mirai-sf/preview.conf（DB接続先など）
#   MIRAI_SF_REPO          git リポジトリ（既定はこのスクリプトを含むリポジトリ）
#   MIRAI_SF_HEALTH_URL    既定 http://127.0.0.1:8782/healthz
#   MIRAI_SF_RESTART_HOOK  systemctl の代わりに実行するファイル（検証用）
#
# 終了コード: 0=成功 / 1=失敗（切替前、または前のリリースへ戻した）/ 2=戻せなかった / 3=破壊的 migration
set -euo pipefail
umask 077

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dry_run=0
no_restart=0
sha_arg=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --no-restart) no_restart=1 ;;
    -*) die "不明なオプション: $arg" ;;
    *)
      [[ -z "$sha_arg" ]] || die "commit SHA は1つだけ指定してください"
      sha_arg="$arg"
      ;;
  esac
done
[[ "$sha_arg" =~ ^[0-9a-f]{7,40}$ ]] || die "使い方: release.sh [--dry-run] [--no-restart] <commit-sha（16進7〜40桁）>"

ops_use_node
ops_guard_overrides 1 "$([[ "$dry_run" == 1 ]] && echo 1 || echo "$no_restart")"

repo="${MIRAI_SF_REPO:-$(git -C "$OPS_DIR" rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$repo" ]] || die "git リポジトリを特定できません。MIRAI_SF_REPO を指定してください"

sha="$(git -C "$repo" rev-parse --verify --quiet "$sha_arg^{commit}")" || die "commit が見つかりません: $sha_arg"
ops_assert_sha "$sha"

git -C "$repo" fetch --quiet origin main || die "origin main を取得できません（main に含まれるか確認できないため中止）"
git -C "$repo" merge-base --is-ancestor "$sha" refs/remotes/origin/main ||
  die "main に含まれない commit は展開しません: $sha"
log "main に含まれることを確認: $sha"

with_env=(node "$OPS_DIR/with-env.mjs")
releases="$OPS_HOME/releases"
release="$releases/$sha"

if [[ "$dry_run" == 1 ]]; then
  work="$(mktemp -d)"
  trap 'rm -rf -- "$work"' EXIT
  git -C "$repo" archive "$sha" db/migrations | tar -x -C "$work"
  code=0
  pending="$("${with_env[@]}" "$OPS_DIR/pending-migrations.sh" "$work/db/migrations")" || code=$?
  log "[dry-run] 未適用の migration: ${pending:-なし}"
  if [[ -z "${MIRAI_SF_RESTART_HOOK:-}" ]]; then
    if ops_unit_uses_current; then
      log "[dry-run] $OPS_API_UNIT は current を参照しています"
    else
      log "[dry-run] 注意: $OPS_API_UNIT が current を参照していません（初回は --no-restart で実行し、unit を入れ替える）"
    fi
  fi
  log "[dry-run] 現在の current: $(ops_current_sha)"
  log "[dry-run] 展開先: $release"
  log "[dry-run] 計画: archive → install → build → backup → migrate → 切替 → 再起動 → healthz"
  [[ "$code" == 0 ]] || log "[dry-run] migration の検査に失敗したため、この commit は展開できません（終了コード $code）"
  exit "$code"
fi

if [[ "$no_restart" != 1 && -z "${MIRAI_SF_RESTART_HOOK:-}" ]] && ! ops_unit_uses_current; then
  die "$OPS_API_UNIT が current を参照していません。初回は --no-restart で実行し、unit を入れ替えてください（docs/deployment.md）"
fi

mkdir -p "$releases"
exec 9>"$OPS_HOME/.ops.lock"
flock -n 9 || die "別のリリース・rollback が実行中です"

if [[ -f "$release/.release-complete" ]]; then
  log "展開済みのリリースを再利用します: $sha"
else
  rm -rf -- "$release"
  mkdir -p "$release"
  git -C "$repo" archive "$sha" | tar -x -C "$release"
  log "展開: $release"
  # NODE_ENV=production だと devDependencies（tsc / vite / tsx）が入らない。秘密値も渡さない
  (
    cd "$release"
    env -u NODE_ENV pnpm install --frozen-lockfile --prod=false
    env -u NODE_ENV pnpm build
  )
  printf 'COMMIT_SHA=%s\n' "$sha" >"$release/release.env"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$release/.release-complete"
  log "ビルド完了"
fi

code=0
pending="$("${with_env[@]}" "$OPS_DIR/pending-migrations.sh" "$release/db/migrations")" || code=$?
if [[ "$code" != 0 ]]; then
  log "破壊的な可能性がある migration があるため中止します（DB も current も変更していません）"
  exit "$code"
fi
log "未適用の migration: ${pending:-なし}"

log "事前バックアップ"
"${with_env[@]}" "$OPS_DIR/backup.sh"

log "migration"
(
  cd "$release"
  "${with_env[@]}" tsx scripts/db.ts migrate
)

if [[ "$no_restart" == 1 ]]; then
  ops_set_current "$sha"
  log "current を切替: $sha（再起動と healthz の確認は未実施）"
  exit 0
fi

code=0
ops_switch_and_verify "$sha" || code=$?
if [[ "$code" != 0 ]]; then
  log "リリース失敗: $sha"
  exit "$code"
fi
log "リリース完了: $sha"
