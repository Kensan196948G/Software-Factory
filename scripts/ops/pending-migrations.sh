#!/usr/bin/env bash
# 未適用の migration を標準出力へ一覧し、破壊的な文を含むものがあれば exit 3 で止める。
# DB は読むだけ。release.sh が with-env 経由で呼ぶ。
#
#   pending-migrations.sh <migrations-dir>
#
# 破壊的な文の判定は文字列照合による補助であり、レビューの代わりにはならない。
# 既存 migration の作法（drop constraint / drop trigger の後に作り直す）は対象外。
set -euo pipefail

# shellcheck source=scripts/ops/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

migrations_dir="${1:-}"
[[ -d "$migrations_dir" ]] || die "migration のディレクトリがありません: $migrations_dir"

ops_use_node
ops_load_db

psql_bin="$(ops_pg_bin psql)"
applied="$("$psql_bin" -X -q -At -v ON_ERROR_STOP=1 -d "$OPS_DB_NAME" -c \
  "select coalesce(to_regclass('public.schema_migrations')::text, '')")"
if [[ -n "$applied" ]]; then
  applied="$("$psql_bin" -X -q -At -v ON_ERROR_STOP=1 -d "$OPS_DB_NAME" -c "select version from schema_migrations")"
fi

destructive='\b(drop\s+(table|column|schema|database|view|materialized|type|sequence|function|index)|truncate|delete\s+from)\b|\balter\s+column\s+\S+\s+(set\s+data\s+)?type\b|\brename\s+(to|column)\b|\balter\s+table\s+[^;]*\bdrop\s+(?!constraint\b)'
blocked=0
shopt -s nullglob
for path in "$migrations_dir"/*.sql; do
  name="$(basename "$path")"
  if grep -Fxq -- "$name" <<<"$applied"; then
    continue
  fi
  printf '%s\n' "$name"
  if sed -e 's/--.*$//' "$path" | tr '\n' ' ' | grep -Piq "$destructive"; then
    printf '破壊的な可能性がある文を含みます: %s\n' "$name" >&2
    blocked=1
  fi
done

[[ "$blocked" == 0 ]] || exit 3
