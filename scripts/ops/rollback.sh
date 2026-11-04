#!/usr/bin/env bash
# 展開済みのリリースへ切り替える。DB は戻さない（migration は additive のみ）。
#
#   scripts/ops/rollback.sh [--dry-run] <commit-sha>
#
# 環境変数: MIRAI_SF_HOME / MIRAI_SF_HEALTH_URL / MIRAI_SF_RESTART_HOOK（release.sh と同じ）
# 終了コード: 0=成功 / 1=失敗（切替前、または元のリリースへ戻した）/ 2=戻せなかった
set -euo pipefail
umask 077

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dry_run=0
sha_arg=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -*) die "不明なオプション: $arg" ;;
    *)
      [[ -z "$sha_arg" ]] || die "commit SHA は1つだけ指定してください"
      sha_arg="$arg"
      ;;
  esac
done
[[ "$sha_arg" =~ ^[0-9a-f]{7,40}$ ]] || die "使い方: rollback.sh [--dry-run] <commit-sha（16進7〜40桁）>"

ops_use_node
ops_guard_overrides 0 "$dry_run"

shopt -s nullglob
matches=("$OPS_HOME/releases/$sha_arg"*)
shopt -u nullglob
[[ "${#matches[@]}" == 1 ]] || die "リリースを1つに特定できません: $sha_arg（候補 ${#matches[@]} 件）"
sha="$(basename "${matches[0]}")"
ops_assert_sha "$sha"
[[ -f "${matches[0]}/.release-complete" && -f "${matches[0]}/release.env" ]] || die "展開が完了していないリリースです: $sha"

current="$(ops_current_sha)"
if [[ "$dry_run" == 1 ]]; then
  log "[dry-run] current: ${current:-（なし）} → $sha（DB は戻しません）"
  exit 0
fi
[[ "$current" != "$sha" ]] || die "既に current です: $sha"

if [[ -z "${MIRAI_SF_RESTART_HOOK:-}" ]] && ! ops_unit_uses_current; then
  die "$OPS_API_UNIT が current を参照していません（docs/deployment.md）"
fi

ops_lock_ops

code=0
ops_switch_and_verify "$sha" || code=$?
if [[ "$code" != 0 ]]; then
  log "rollback 失敗: $sha"
  exit "$code"
fi
# worker も同じリリースへ戻す（動いているときだけ）
if [[ -z "${MIRAI_SF_RESTART_HOOK:-}" ]] && [[ "$OPS_WORKER_UNIT" != none ]] && systemctl --user is-active --quiet "$OPS_WORKER_UNIT"; then
  systemctl --user restart "$OPS_WORKER_UNIT" || log "注意: worker の再起動に失敗しました"
fi
log "rollback 完了: $sha（DB は戻していません）"
