#!/usr/bin/env bash
# Staging を origin/main に追従させる（main が進んだときだけ配備する）。
#
#   scripts/ops/staging-autofollow.sh [--check|--dry-run]
#
# 流れ:
#   1. 多重実行防止（flock）
#   2. git fetch → origin/main の commit を固定
#   3. current と同一なら no-op（/healthz の commit・db.ok・environment のずれは異常として失敗）
#   4. main・clean の controller を確認し、HEAD が対象 SHA の祖先であることを確認する
#      （controller を自己更新しない。target は git archive から配備。diverged・dirty は配備しない）
#   5. .ops.lock を取り、current を読み直す（CI ゲート中も保持する）
#   6. exact-main CI ゲート（check-release-ci.mjs）: 対象 SHA の push/main ci.yml の
#      最新 attempt で quality/e2e/docker と run が成功していることを必須にする。
#      一時的な未確認（run なし・実行中）は 75、失敗・job 欠落・API 情報不足・照会エラーは 1 で配備しない
#   7. 既存の release.sh で配備（切替・再起動・/healthz 確認・失敗時の戻しは release.sh に任せる。
#      ゲートは 6 で済んでいるので MIRAI_SF_RELEASE_CI_GATE は渡さない）
#   8. 配備後に /healthz を独立に確認し、だめなら直前のリリースへ戻す
#   9. 成功後に古い releases を整理する（current/previous と直近 N 世代を保持）
#
# 終了コード:
#   0  追従済み（no-op）または配備成功
#   1  失敗（health 不一致、CI の恒久的な失敗・必須 job 欠落・API 情報不足・照会エラーなど。
#      直前のリリースへ戻した場合を含む）
#   2  失敗して直前のリリースへ戻せなかった（手動で復旧する）
#   3  破壊的な可能性がある migration のため中止（release.sh の判定）
#   75 配備しない（一時的）: 別の実行（autofollow／手動 release/rollback）が進行中、
#      実行元が main・clean でない、diverged、または exact-main CI がまだ実行中・run 未作成
#      （skip。timer は SuccessExitStatus=75 で成功扱い）
#
# 環境変数（release.sh と共通のものは lib.sh を参照）:
#   MIRAI_SF_REPO                      git リポジトリ（既定: このスクリプトを含むリポジトリ）
#   MIRAI_SF_HEALTH_URL                既定 http://127.0.0.1:8782/healthz
#   MIRAI_SF_RELEASE_SCRIPT            既定 scripts/ops/release.sh（検証用に差し替え可）
#   MIRAI_SF_ROLLBACK_SCRIPT           既定 scripts/ops/rollback.sh（検証用に差し替え可）
#   MIRAI_SF_HEALTH_ENV                期待する environment（既定 staging。別アプリの誤判定を防ぐ）
#   MIRAI_SF_AUTOFOLLOW_STATE_FILE     既定 ~/.local/state/mirai-sf/autofollow.json
#   MIRAI_SF_AUTOFOLLOW_HEALTH_RETRIES 既定 5（配備後の確認回数）
#   MIRAI_SF_AUTOFOLLOW_KEEP_RELEASES  既定 5（current/previous のほかに残す世代数）
#   MIRAI_SF_AUTOFOLLOW_PRUNE          既定 1。0 で releases の整理を無効化
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
    -h | --help) awk 'NR > 1 && /^set -euo pipefail$/ { exit } NR > 1 { print }' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) die "不明なオプション: $arg（--check / --dry-run のみ）" ;;
    *) die "引数は取りません: $arg" ;;
  esac
done

ops_use_node
export GIT_TERMINAL_PROMPT=0

repo="${MIRAI_SF_REPO:-$(git -C "$OPS_DIR" rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$repo" ]] || die "git リポジトリを特定できません。MIRAI_SF_REPO を指定してください"

health_url="${MIRAI_SF_HEALTH_URL:-http://127.0.0.1:8782/healthz}"
expected_env="${MIRAI_SF_HEALTH_ENV:-staging}"
release_script="${MIRAI_SF_RELEASE_SCRIPT:-$OPS_DIR/release.sh}"
rollback_script="${MIRAI_SF_ROLLBACK_SCRIPT:-$OPS_DIR/rollback.sh}"
ci_gate_script="$OPS_DIR/check-release-ci.mjs"
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
  local action="$1" code="$2" dir tmp db_ok=false prev_json=""
  [[ "$HEALTH_DBOK" != true ]] || db_ok=true
  if [[ "$previous" =~ ^[0-9a-f]{40}$ ]]; then prev_json="$previous"; fi
  dir="$(dirname "$state_file")"
  mkdir -p "$dir"
  tmp="$state_file.tmp.$$"
  {
    printf '{\n'
    printf '  "version": 1,\n'
    printf '  "at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "action": "%s",\n' "$action"
    printf '  "target": "%s",\n' "$target"
    printf '  "previous": "%s",\n' "$prev_json"
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
  # 読めなかったときに前回の値を残さない
  HEALTH_STATUS=""
  HEALTH_ENV=""
  HEALTH_COMMIT=""
  HEALTH_DBOK=""
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
  [[ "$HEALTH_STATUS" == ok && "$HEALTH_DBOK" == true && "$HEALTH_COMMIT" == "$1" && "$HEALTH_ENV" == "$expected_env" ]]
}

# 実行元の作業ツリーが main・clean か（ブランチ切替中のコードを 10 分毎に配備しないため）
checkout_head() {
  git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null || true
}

checkout_is_clean() {
  [[ -z "$(git -C "$repo" status --porcelain 2>/dev/null || true)" ]]
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
  OPS_LOCK_HELD=1 bash "$rollback_script" "$prev" || rc=$?
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

# 古いリリースを整理する。current/previous と直近 N 世代だけ残す（既定 N=5）。
# 本番ホーム（*-prod）と MIRAI_SF_AUTOFOLLOW_PRUNE=0 では何もしない。
prune_releases() {
  local current="$1" prev="$2" keep="${MIRAI_SF_AUTOFOLLOW_KEEP_RELEASES:-5}"
  local releases="$OPS_HOME/releases" entry kept=0 removed=0
  local dirs=()
  if [[ "${MIRAI_SF_AUTOFOLLOW_PRUNE:-1}" == 0 ]]; then
    log "releases の整理は無効です（MIRAI_SF_AUTOFOLLOW_PRUNE=0）"
    return 0
  fi
  if [[ "$OPS_HOME" == *"-prod"* ]]; then
    log "本番ホームのため releases は整理しません: $OPS_HOME"
    return 0
  fi
  [[ -d "$releases" ]] || return 0
  [[ "$keep" =~ ^[0-9]+$ ]] || keep=5
  mapfile -t dirs < <(find "$releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' 2>/dev/null | sort -rn | cut -d' ' -f2-)
  for entry in "${dirs[@]}"; do
    [[ "$entry" =~ ^[0-9a-f]{40}$ ]] || continue
    [[ "$entry" != "$current" && "$entry" != "$prev" ]] || continue
    kept=$((kept + 1))
    ((kept > keep)) || continue
    [[ -f "${releases:?}/${entry:?}/.release-complete" ]] || continue
    if rm -rf -- "${releases:?}/${entry:?}"; then
      removed=$((removed + 1))
    else
      log "注意: 古いリリースを削除できません: $entry"
    fi
  done
  log "releases を整理: ${removed} 世代を削除（current/previous と直近 ${keep} 世代を保持）"
  return 0
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
  head="$(checkout_head)"
  if [[ "$head" != main ]] || ! checkout_is_clean; then
    log "[dry-run] 注意: 実行元が main・clean ではありません（HEAD=${head:-detached}）。配備モードでは skip（exit 75）"
  fi
  log "[dry-run] 更新あり: ${previous:-（なし）} → $target"
  log "[dry-run] 計画: fetch 済み → release.sh $target（切替・再起動・healthz 確認・失敗時は $previous へ戻す）"
  log "[dry-run] 変更するのは fetch した refs と状態ファイルだけ（配備・DB・サービスは変更しない）"
  log "[dry-run] exact-main CI ゲートは配備モードでのみ実行する（--dry-run では照会しない）"
  finish "dry-run" 0
fi

head="$(checkout_head)"
if [[ "$head" != main ]] || ! checkout_is_clean; then
  log "実行元が main・clean ではありません（HEAD=${head:-detached}）。作業ツリーのブランチに依存した配備をしないため中止（exit 75）"
  finish "skipped" 75
fi

# controller と配備対象を分離する。実行中の Bash / gate / helper を git merge で
# 書き換えない。clean main の HEAD が target の祖先なら、checkout はそのままで
# trusted controller のゲートを通し、release.sh が git archive target を配備する。
# controller 自体の更新は停止・main CI確認・ff-only同期の保守手順で行う。
head_sha="$(git -C "$repo" rev-parse HEAD)"
if ! git -C "$repo" merge-base --is-ancestor "$head_sha" "$target"; then
  log "実行元の HEAD が対象 SHA の祖先ではありません（local commits/diverged。HEAD=$head_sha target=$target）。配備しません（exit 75）"
  finish "skipped" 75
fi
log "controller=$head_sha target=$target（実行元は変更しません）"

# 手動の release/rollback と同じ .ops.lock を取る（競合したら触らず skip）。
# CI ゲートの間も保持し、ゲート中に手動配備が進んで current が変わるのを防ぐ。
exec 9>"$OPS_HOME/.ops.lock"
if ! flock -n 9; then
  log "手動の release/rollback が実行中です（触らない。終了コード 75）"
  finish "skipped" 75
fi

# ロック取得後に current を読み直す（ゲート中に current が変わった場合の取り違えを防ぐ）。
previous="$(ops_current_sha)"
log "current=${previous:-（なし）} origin/main=$target"

# exact-main CI ゲート。0=確認済み、75=一時的な未確認（配備しない）、1=失敗/照会不能
log "exact-main CI ゲート: $target"
gate=0
node "$ci_gate_script" "$target" || gate=$?
if [[ "$gate" == 75 ]]; then
  log "exact-main CI が未確認のため配備しません（exit 75。bypass はありません）"
  finish "skipped" 75
fi
if [[ "$gate" != 0 ]]; then
  log "exact-main CI が失敗または照会不能のため配備しません（exit 1）"
  finish "failed" 1
fi

log "配備を開始: ${previous:-（なし）} → $target（release.sh）"
code=0
# .ops.lock はこのプロセスが保持しているので、release.sh 側では取り直さない。
# CI ゲートはこのスクリプトで実施済み。呼び出し元の環境に MIRAI_SF_RELEASE_CI_GATE が残っていても
# release.sh で二重照会しない（照会結果の 75 が release.sh 失敗→1 に化けるのを防ぐ）
env -u MIRAI_SF_RELEASE_CI_GATE OPS_LOCK_HELD=1 bash "$release_script" "$target" || code=$?
if [[ "$code" == 3 ]]; then
  log "破壊的な可能性がある migration のため中止しました（DB も current も変更していません）"
  finish "failed" 3
fi

if [[ "$code" == 0 ]]; then
  if wait_for_target "$target" && [[ "$(ops_current_sha)" == "$target" ]]; then
    log "配備成功: $target（$(describe_health)）"
    prune_releases "$target" "$previous" || log "注意: releases の整理に失敗しました"
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
