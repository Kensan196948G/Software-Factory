#!/usr/bin/env bash
# DATABASE_URL の DB を pg_dump -Fc で保存する。件数の一覧（manifest）を同じスナップショットで残す。
#
#   node scripts/ops/with-env.mjs scripts/ops/backup.sh
#
# 環境変数:
#   DATABASE_URL                    対象DB（必須。ログには出さない）
#   MIRAI_SF_BACKUP_DIR             保存先（既定 ~/.local/state/mirai-sf/backups）
#   MIRAI_SF_BACKUP_RETENTION_DAYS  世代（既定 14 日）
#   MIRAI_SF_PG_BIN_DIR             PostgreSQL クライアントの場所（既定 /usr/lib/postgresql/16/bin）
set -euo pipefail
umask 077

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ops_use_node
ops_load_db

dir="${MIRAI_SF_BACKUP_DIR:-$HOME/.local/state/mirai-sf/backups}"
retention="${MIRAI_SF_BACKUP_RETENTION_DAYS:-14}"
[[ "$retention" =~ ^[1-9][0-9]*$ ]] || die "MIRAI_SF_BACKUP_RETENTION_DAYS が不正です"

mkdir -p "$dir"
chmod 700 "$dir"

exec 9>"$dir/.lock-$OPS_DB_NAME"
flock -n 9 || die "同じDBのバックアップが実行中です: $OPS_DB_NAME"

base="$OPS_DB_NAME-$(date -u +%Y%m%dT%H%M%SZ)"
dump="$dir/$base.dump"
manifest="$dir/$base.manifest.tsv"
tmp_dump="$dir/.$base.dump.tmp"
tmp_manifest="$dir/.$base.manifest.tmp"
[[ ! -e "$dump" ]] || die "同名のバックアップが既にあります: $base"

cleanup() {
  local code=$?
  rm -f -- "$tmp_dump" "$tmp_manifest"
  if [[ -n "${SNAP_PID:-}" ]]; then
    kill "$SNAP_PID" 2>/dev/null || true
    wait "$SNAP_PID" 2>/dev/null || true
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# スナップショットを保持する接続（dump と件数を同じ時点に揃える）
coproc SNAP { "$(ops_pg_bin psql)" -X -q -At -v ON_ERROR_STOP=1 -d "$OPS_DB_NAME"; }
printf 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n' >&"${SNAP[1]}"
snapshot=""
IFS= read -r -t 30 snapshot <&"${SNAP[0]}" || die "スナップショットを取得できません: $OPS_DB_NAME"
[[ "$snapshot" =~ ^[0-9A-Fa-f-]+$ ]] || die "スナップショットの形式が不正です"

ops_table_counts "$OPS_DB_NAME" "$snapshot" >"$tmp_manifest" || die "件数の取得に失敗しました: $OPS_DB_NAME"
"$(ops_pg_bin pg_dump)" -Fc --snapshot="$snapshot" --file="$tmp_dump" || die "pg_dump に失敗しました: $OPS_DB_NAME"
"$(ops_pg_bin pg_restore)" --list "$tmp_dump" >/dev/null || die "dump の読み取り確認に失敗しました: $base"

chmod 600 "$tmp_dump" "$tmp_manifest"
mv -- "$tmp_manifest" "$manifest"
mv -- "$tmp_dump" "$dump"

# 世代管理。この手順で作ったファイル名だけを対象にする（手動の dump には触らない）
removed=0
while IFS= read -r -d '' old; do
  rm -f -- "$old"
  removed=$((removed + 1))
done < <(find "$dir" -maxdepth 1 -type f -regextype posix-extended \
  -regex ".*/$OPS_DB_NAME-[0-9]{8}T[0-9]{6}Z\.(dump|manifest\.tsv)" \
  -mmin +"$((retention * 1440))" -not -name "$base.*" -print0)

log "backup OK db=$OPS_DB_NAME file=$dump size=$(stat -c %s "$dump") tables=$(grep -vc '^#' "$manifest") removed_old_files=$removed retention_days=$retention"
