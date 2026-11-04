#!/usr/bin/env bash
# Staging を origin/main に追従させる（main が進んだときだけ配備する）。
#
#   scripts/ops/staging-autofollow.sh [--check|--dry-run]
#
# 流れ:
#   1. 多重実行防止（flock）
#   2. git fetch → origin/main の commit を固定
#   3. current と同一なら no-op（ただし /healthz の commit・db.ok のずれは異常として失敗）
#   4. 既存の release.sh で配備（切替・再起動・/healthz 確認・失敗時の戻しは release.sh に任せる）
#   5. 配備後に /healthz を独立に確認し、だめなら直前のリリースへ戻す
#
# 終了コード:
#   0  追従済み（no-op）または配備成功
#   1  失敗（health 不一致など。直前のリリースへ戻した場合を含む）
#   2  失敗して直前のリリースへ戻せなかった（手動で復旧する）
#   3  破壊的な可能性がある migration のため中止（release.sh の判定）
#   75 別の実行が進行中（多重実行防止。timer は SuccessExitStatus=75 で成功扱い）
#
# 環境変数（release.sh と共通のものは lib.sh を参照）:
#   MIRAI_SF_REPO                      git リポジトリ（既定: このスクリプトを含むリポジトリ）
#   MIRAI_SF_HEALTH_URL                既定 http://127.0.0.1:8782/healthz
#   MIRAI_SF_RELEASE_SCRIPT            既定 scripts/ops/release.sh（検証用に差し替え可）
#   MIRAI_SF_ROLLBACK_SCRIPT           既定 scripts/ops/rollback.sh（検証用に差し替え可）
#   MIRAI_SF_AUTOFOLLOW_STATE_FILE     既定 ~/.local/state/mirai-sf/autofollow.json
#   MIRAI_SF_AUTOFOLLOW_HEALTH_RETRIES 既定 5（配備後の確認回数）
#
# 秘密情報は出力しない（/healthz の本文は出さず、確認済みの項目だけを出す）。
# 非対話で動く（git の資格情報入力を待たない）。
set -euo pipefail
umask 077

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dry_run=0
for arg in "$@"; do
  case "$arg" in
    --check | --dry-run) dry_run=1 ;;
    -h | --help) sed -n '2,31p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) die "不明なオプション: $arg（--check / --dry-run のみ）" ;;
    *) die "引数は取りません: $arg" ;;
  esac
done

ops_use_node
export GIT_TERMINAL_PROMPT=0

repo="${MIRAI_SF_REPO:-$(git -C "$OPS_DIR" rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$repo" ]] || die "git リポジトリを特定できません。MIRAI_SF_REPO を指定してください"

health_url="${MIRAI_SF_HEALTH_URL:-http://127.0.0.1:8782/healthz}"
release_script="${MIRAI_SF_RELEASE_SCRIPT:-$OPS_DIR/release.sh}"
rollback_script="${MIRAI_SF_ROLLBACK_SCRIPT:-$OPS_DIR/rollback.sh}"
state_file="${MIRAI_SF_AUTOFOLLOW_STATE_FILE:-$HOME/.local/state/mirai-sf/autofollow.json}"
lock_file="$OPS_HOME/.autofollow.lock"

# /healthz から読んだ値（本文はログへ出さない）
HEALTH_STATUS=""
HEALTH_ENV=""
HEALTH_COMMIT=""
HEALTH_DBOK=""

target=""
previous=""

# KEY=VALUE に相当する固定値だけを書く（SHA は 40 桁の 16 進、action は内部の列挙）。
write_state() {
  local action="$1" code="$2" dir tmp db_ok=false
  [[ "$HEALTH_DBOK" != true ]] || db_ok=true
  dir="$(dirname "$state_file")"
  mkdir -p "$dir"
  tmp="$state_file.tmp.$$"
  {
    printf '{\n'
    printf '  "version": 1,\n'
    printf '  "at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "action": "%s",\n' "$action"
    printf '  "target": "%s",\n' "$target"
    printf '  "previous": "%s",\n' "$previous"
    printf '  "healthCommit": "%s",\n' "$HEALTH_COMMIT"
    printf '  "healthEnvironment": "%s",\n' "$HEALTH_ENV"
    printf '  "healthDbOk": %s,\n' "$db_ok"
    printf '  "exitCode": %d\n' "$code"
    printf '}\n'
  } >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$state_file"
}

finish() {
  local action="$1" code="$2"
  write_state "$action" "$code" || log "注意: 状態ファイルを書き込めません（$state_file）"
  log "autofollow 終了: action=$action exit=$code"
  exit "$code"
}

# /healthz を読み取り、HEALTH_* へ入れる。接続・JSON 不正は失敗。
probe_health() {
  local body line
  body="$(curl -fsS --max-time 3 "$health_url" 2>/dev/null)" || return 1
  line="$(
    printf '%s' "$body" | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        let health;
        try { health = JSON.parse(raw); } catch { process.exit(1); }
        const safe = (value) => (typeof value === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? value : "(想定外)");
        const commit = typeof health.commit === "string" && /^[0-9a-f]{40}$/.test(health.commit) ? health.commit : "";
        const dbOk = Boolean(health.db && typeof health.db === "object" && health.db.ok === true);
        process.stdout.write([safe(health.status), safe(health.environment), commit, dbOk ? "true" : "false"].join("\t"));
      });
    '
  )" || return 1
  IFS=$'\t' read -r HEALTH_STATUS HEALTH_ENV HEALTH_COMMIT HEALTH_DBOK <<<"$line"
  return 0
}

# 確認済みの項目だけを出す（本文・設定値は出さない）。
describe_health() {
  printf 'status=%s environment=%s db.ok=%s commit=%s' \
    "${HEALTH_STATUS:-不明}" "${HEALTH_ENV:-不明}" "${HEALTH_DBOK:-不明}" "${HEALTH_COMMIT:-不明}"
}

health_matches() {
  [[ "$HEALTH_STATUS" == ok && "$HEALTH_DBOK" == true && "$HEALTH_COMMIT" == "$1" ]]
}

# 配備後の確認。再起動直後の数秒を許すため数回試す。
wait_for_target() {
  local sha="$1" retries="${MIRAI_SF_AUTOFOLLOW_HEALTH_RETRIES:-5}" i
  for ((i = 1; i <= retries; i++)); do
    if probe_health && health_matches "$sha"; then
      log "healthz OK（${sha}, 試行 ${i} 回目: $(describe_health)）"
      return 0
    fi
    sleep 1
  done
  return 1
}

# 直前のリリースへ戻し、healthz で確認する。戻せたら 0。
recover_to_previous() {
  local prev="$1" rc=0
  if [[ -z "$prev" ]]; then
    log "戻す先のリリースがありません（手動で復旧してください）"
    return 1
  fi
  if [[ "$(ops_current_sha)" == "$prev" ]]; then
    # release.sh が切替前に止まった（ビルド失敗・migration 検査など）。current は元のまま
    if probe_health && health_matches "$prev"; then
      log "current は元のリリースのままです: $prev（$(describe_health)）"
      return 0
    fi
    log "current は元のままですが healthz が一致しません: $prev（$(describe_health)）"
    return 1
  fi
  log "直前のリリースへ戻します: $prev"
  bash "$rollback_script" "$prev" || rc=$?
  if [[ "$rc" != 0 ]]; then
    log "rollback に失敗しました（終了コード $rc）"
    return 1
  fi
  if probe_health && health_matches "$prev"; then
    log "直前のリリースで復旧しました: $prev（$(describe_health)）"
    return 0
  fi
  log "戻した後も healthz が一致しません（$(describe_health)）"
  return 1
}

if [[ "$dry_run" != 1 ]]; then
  mkdir -p "$OPS_HOME"
  # 8 は autofollow 専用。release.sh / rollback.sh は別の .ops.lock を取る
  exec 8>"$lock_file"
  if ! flock -n 8; then
    log "別の autofollow が実行中です（skip。終了コード 75）"
    finish "skipped" 75
  fi
fi

log "autofollow 開始（mode=$([[ "$dry_run" == 1 ]] && echo check || echo deploy)）"

if ! git -C "$repo" fetch --quiet origin main; then
  log "origin main を取得できません（古い情報で配備しないため中止）"
  finish "failed" 1
fi
target="$(git -C "$repo" rev-parse --verify --quiet 'refs/remotes/origin/main^{commit}' || true)"
if [[ ! "$target" =~ ^[0-9a-f]{40}$ ]]; then
  log "origin/main の commit を特定できません"
  finish "failed" 1
fi
ops_assert_sha "$target"
previous="$(ops_current_sha)"
log "current=${previous:-（なし）} origin/main=$target"

# 追従済みの判定。current が同じでも healthz がずれていれば異常として失敗にする
if [[ -n "$previous" && "$previous" == "$target" ]]; then
  if ! probe_health; then
    log "current は origin/main と同じですが /healthz を読めません（$health_url）"
    finish "failed" 1
  fi
  if health_matches "$target"; then
    log "no-op: 追従済み（$(describe_health)）"
    finish "noop" 0
  fi
  log "current は origin/main と同じですが healthz が一致しません（$(describe_health)）"
  finish "failed" 1
fi

if [[ "$dry_run" == 1 ]]; then
  if probe_health; then
    log "現在の healthz: $(describe_health)"
  else
    log "現在の healthz: 読めません（$health_url）"
  fi
  log "[dry-run] 更新あり: ${previous:-（なし）} → $target"
  log "[dry-run] 計画: fetch 済み → release.sh $target（切替・再起動・healthz 確認・失敗時は $previous へ戻す）"
  finish "dry-run" 0
fi

log "配備を開始: ${previous:-（なし）} → $target（release.sh）"
code=0
bash "$release_script" "$target" || code=$?
if [[ "$code" == 3 ]]; then
  log "破壊的な可能性がある migration のため中止しました（DB も current も変更していません）"
  finish "failed" 3
fi

if [[ "$code" == 0 ]]; then
  if wait_for_target "$target" && [[ "$(ops_current_sha)" == "$target" ]]; then
    log "配備成功: $target（$(describe_health)）"
    finish "deployed" 0
  fi
  # release.sh は成功を返したが、独立した確認で合わない（current のずれ・health のずれ）
  log "配備後の確認に失敗しました（current=$(ops_current_sha) / $(describe_health)）"
  if recover_to_previous "$previous"; then
    finish "failed" 1
  fi
  finish "failed" 2
fi

log "release.sh が失敗しました（終了コード $code）"
if recover_to_previous "$previous"; then
  finish "failed" 1
fi
finish "failed" 2
