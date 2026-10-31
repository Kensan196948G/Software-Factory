#!/usr/bin/env bash
# 最新のバックアップを一時DB mirai_sf_drill_<ts> へ復元して検証し、一時DBを必ず消す。
# 本来のDBへは接続しない（DATABASE_URL はDB名と接続先の特定にだけ使う）。
#
#   node scripts/ops/with-env.mjs scripts/ops/restore-drill.sh
#
# 検証: 1) manifest（バックアップ時点の件数・監査ログ末尾ハッシュ）との完全一致
#       2) scripts/db.ts verify（監査ログのハッシュ連鎖を含む）
#
# 環境変数: DATABASE_URL / MIRAI_SF_BACKUP_DIR / MIRAI_SF_PG_BIN_DIR（backup.sh と同じ）
set -euo pipefail
umask 077

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ops_use_node
ops_load_db

DRILL_PATTERN='^mirai_sf_drill_[0-9a-z_]+$'
source_db="$OPS_DB_NAME"
[[ ! "$source_db" =~ $DRILL_PATTERN ]] || die "drill 用のDBを復元元にはできません"

dir="${MIRAI_SF_BACKUP_DIR:-$HOME/.local/state/mirai-sf/backups}"
[[ -d "$dir" ]] || die "バックアップの保存先がありません: $dir"

latest=""
shopt -s nullglob
for file in "$dir/$source_db"-*.dump; do
  [[ "$(basename "$file")" =~ ^${source_db}-[0-9]{8}T[0-9]{6}Z\.dump$ ]] && latest="$file"
done
shopt -u nullglob
[[ -n "$latest" ]] || die "バックアップがありません: db=$source_db"
manifest="${latest%.dump}.manifest.tsv"
[[ -f "$manifest" ]] || die "manifest がありません: $(basename "$manifest")"

drill_db="mirai_sf_drill_$(date -u +%Y%m%dt%H%M%Sz)_$$"
[[ "$drill_db" =~ $DRILL_PATTERN && "$drill_db" != "$source_db" ]] || die "drill のDB名が不正です"

work="$(mktemp -d)"
created=0

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  rm -rf -- "$work"
  if [[ "$created" == 1 ]]; then
    if [[ "$drill_db" =~ $DRILL_PATTERN ]] &&
      "$(ops_pg_bin dropdb)" --maintenance-db=postgres --if-exists --force "$drill_db"; then
      log "一時DBを削除しました: $drill_db"
    else
      printf '一時DBを削除できませんでした: %s\n' "$drill_db" >&2
      [[ "$code" != 0 ]] || code=1
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 以降、接続先は常に -d / --maintenance-db で明示する（本来のDBを既定にしない）
unset PGDATABASE

log "drill 開始 source=$source_db backup=$(basename "$latest") drill_db=$drill_db"

# 名前が衝突して createdb が失敗した場合は、自分で作っていないので消さない
"$(ops_pg_bin createdb)" --maintenance-db=postgres --template=template0 --encoding=UTF8 "$drill_db"
created=1

"$(ops_pg_bin pg_restore)" --exit-on-error --no-owner --no-privileges -d "$drill_db" "$latest"
log "復元 OK"

ops_table_counts "$drill_db" >"$work/restored.tsv" || die "復元先の件数を取得できません"
if ! diff -u "$manifest" "$work/restored.tsv"; then
  die "件数または監査ログ末尾のハッシュが manifest と一致しません"
fi
log "件数照合 OK（$(grep -vc '^#' "$work/restored.tsv") テーブル）"

drill_url="$(node "$OPS_DIR/pg-env.mjs" --url-for-db "$drill_db")"
tsx_bin="$OPS_ROOT/node_modules/.bin/tsx"
[[ -x "$tsx_bin" ]] || die "tsx が見つかりません: $tsx_bin"
(
  cd "$OPS_ROOT"
  unset MIRAI_SF_CONFIG_FILE MIGRATION_DATABASE_URL TEST_MIGRATION_DATABASE_URL
  # argv に載せない（ps で見えるため）
  export DATABASE_URL="$drill_url"
  "$tsx_bin" scripts/db.ts verify
) || die "db:verify（監査ログのハッシュ連鎖を含む）に失敗しました"

log "drill OK source=$source_db backup=$(basename "$latest")"
