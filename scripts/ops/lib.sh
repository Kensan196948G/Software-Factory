# shellcheck shell=bash
# scripts/ops/*.sh の共通処理。接続文字列・秘密値はログへ出さない（set -x を使わない）。

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034 # restore-drill.sh が使う
OPS_ROOT="$(cd "$OPS_DIR/../.." && pwd)"

OPS_DEFAULT_HOME="$HOME/.local/share/mirai-sf"
OPS_HOME="${MIRAI_SF_HOME:-$OPS_DEFAULT_HOME}"
OPS_API_UNIT="${MIRAI_SF_API_UNIT:-mirai-sf-api.service}"
# current を参照する worker。本番で worker を動かさない場合は MIRAI_SF_WORKER_UNIT=none にする
# shellcheck disable=SC2034 # release.sh / rollback.sh が使う
OPS_WORKER_UNIT="${MIRAI_SF_WORKER_UNIT:-mirai-sf-worker.service}"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() {
  printf '[%s] エラー: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
  exit 1
}

# Node 22 を使う（systemd user や非対話シェルの PATH は /usr/bin/node = v20 のことがある）
ops_use_node() {
  local dir="${MIRAI_SF_NODE_BIN_DIR:-$HOME/.nvm/versions/node/v22.22.3/bin}"
  if [[ -x "$dir/node" ]]; then
    PATH="$dir:$PATH"
    export PATH
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')" || die "node を実行できません"
  [[ "$major" -ge 22 ]] || die "Node 22 以上が必要です（検出: $major）。MIRAI_SF_NODE_BIN_DIR で指定してください"
}

# PostgreSQL 16 のクライアントを優先する（新しい pg_dump の出力は 16 への restore で警告が出る）
ops_pg_bin() {
  local dir="${MIRAI_SF_PG_BIN_DIR:-/usr/lib/postgresql/16/bin}"
  if [[ -x "$dir/$1" ]]; then
    printf '%s/%s' "$dir" "$1"
  else
    command -v "$1" || die "$1 が見つかりません"
  fi
}

# DATABASE_URL を PG* 環境変数へ展開し、OPS_DB_NAME を設定する
ops_load_db() {
  local exports
  exports="$(node "$OPS_DIR/pg-env.mjs")" || die "DATABASE_URL を解釈できません"
  eval "$exports"
  OPS_DB_NAME="$PGDATABASE"
  [[ "$OPS_DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || die "DB名が不正です"
}

# 件数の一覧（監査ログ末尾のハッシュ＋テーブルごとの count）をタブ区切りで出す。
# 引数: DB名 [エクスポート済みスナップショット]
ops_table_counts() {
  local db="$1" snapshot="${2:-}" psql_bin union set_snapshot=""
  psql_bin="$(ops_pg_bin psql)"
  union="$("$psql_bin" -X -q -At -v ON_ERROR_STOP=1 -d "$db" -c \
    "select string_agg(format('select %L as t, count(*)::bigint as c from %I.%I', tablename, schemaname, tablename), ' union all ') from pg_tables where schemaname = 'public'")" ||
    return 1
  [[ -n "$union" ]] || {
    printf 'public スキーマにテーブルがありません: %s\n' "$db" >&2
    return 1
  }
  [[ -z "$snapshot" ]] || set_snapshot="SET TRANSACTION SNAPSHOT '$snapshot';"
  "$psql_bin" -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -d "$db" <<SQL
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
$set_snapshot
select '#audit_tip', coalesce((select hash from audit_log order by id desc limit 1), '');
select t, c from ($union) s order by t collate "C";
COMMIT;
SQL
}

# ───────── リリース切替（release.sh / rollback.sh 共通） ─────────

ops_assert_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "commit SHA が不正です"
}

# 使い捨てのルートで実サービスや実DBを触らないための確認
ops_guard_overrides() {
  local needs_env="$1" no_restart="$2"
  [[ "$OPS_HOME" != "$OPS_DEFAULT_HOME" ]] || return 0
  if [[ "$no_restart" != 1 && -z "${MIRAI_SF_RESTART_HOOK:-}" && -z "${MIRAI_SF_API_UNIT:-}" ]]; then
    die "MIRAI_SF_HOME を差し替えるときは MIRAI_SF_RESTART_HOOK / MIRAI_SF_API_UNIT / --no-restart のいずれかが必要です（実サービスを再起動しないため）"
  fi
  if [[ "$needs_env" == 1 && -z "${MIRAI_SF_ENV_FILE:-}" ]]; then
    die "MIRAI_SF_HOME を差し替えるときは MIRAI_SF_ENV_FILE が必要です（実DBへ migration しないため）"
  fi
}

# .ops.lock を取る。呼び出し元（staging-autofollow.sh）が既に保持している場合は
# OPS_LOCK_HELD=1 で渡され、二重に取らない（同じロックを親子で取り直すと自分自身と衝突する）。
ops_lock_ops() {
  if [[ "${OPS_LOCK_HELD:-}" == 1 ]]; then
    log ".ops.lock は呼び出し元が保持しています"
    return 0
  fi
  exec 9>"$OPS_HOME/.ops.lock"
  flock -n 9 || die "別のリリース・rollback が実行中です"
}

# 稼働中の unit が current を見ていないと、再起動しても切り替わらない
ops_unit_uses_current() {
  local dir
  dir="$(systemctl --user show -p WorkingDirectory --value "$OPS_API_UNIT" 2>/dev/null)" || return 1
  [[ "$dir" == "$OPS_HOME/current" ]]
}

ops_current_sha() {
  local link="$OPS_HOME/current"
  if [[ -L "$link" ]]; then basename "$(readlink "$link")"; fi
}

ops_set_current() {
  ops_assert_sha "$1"
  local tmp="$OPS_HOME/.current.$$"
  ln -s "releases/$1" "$tmp"
  mv -T "$tmp" "$OPS_HOME/current"
}

ops_restart_api() {
  if [[ -n "${MIRAI_SF_RESTART_HOOK:-}" ]]; then
    # 長く動くプロセスへロックの fd を引き継がない
    "$MIRAI_SF_RESTART_HOOK" 9>&-
  else
    systemctl --user restart "$OPS_API_UNIT"
  fi
}

# /healthz が ok・DB ok・期待する commit を返すまで待つ
ops_wait_healthy() {
  local sha="$1" url="${MIRAI_SF_HEALTH_URL:-http://127.0.0.1:8782/healthz}"
  local retries="${MIRAI_SF_HEALTH_RETRIES:-30}" i body=""
  for ((i = 1; i <= retries; i++)); do
    if body="$(curl -fsS --max-time 3 "$url" 2>/dev/null)" &&
      EXPECT_SHA="$sha" node -e '
        const h = JSON.parse(process.argv[1]);
        process.exit(h.status === "ok" && h.db && h.db.ok === true && h.commit === process.env.EXPECT_SHA ? 0 : 1);
      ' "$body" 2>/dev/null; then
      log "healthz OK（commit=$sha, 試行 $i 回目）"
      return 0
    fi
    sleep 1
  done
  log "healthz NG（期待する commit=$sha, 試行 $retries 回）"
  return 1
}

# current を切り替えて再起動し、healthz を確認する。失敗したら前のリリースへ戻す。
# 戻り値: 0=成功 / 1=失敗して前のリリースへ戻した / 2=失敗して戻せなかった
ops_switch_and_verify() {
  local target="$1" previous
  previous="$(ops_current_sha)"
  ops_set_current "$target"
  log "current を切替: ${previous:-（なし）} → $target"
  if ops_restart_api && ops_wait_healthy "$target"; then
    return 0
  fi
  log "切替後の確認に失敗しました"
  if [[ -z "$previous" || "$previous" == "$target" ]]; then
    log "戻す先のリリースがありません（手動で復旧してください）"
    return 2
  fi
  ops_set_current "$previous"
  log "current を前のリリースへ戻します: $previous"
  if ops_restart_api && ops_wait_healthy "$previous"; then
    log "前のリリースで復旧しました（DB は戻していません）"
    return 1
  fi
  log "前のリリースでも healthz が通りません（手動で復旧してください）"
  return 2
}
