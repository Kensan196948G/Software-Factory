#!/usr/bin/env bash
# 本番バックアップの復元ドリル（一時DBを作って検証し、必ず消す）。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MIRAI_SF_HOME="${MIRAI_SF_PROD_HOME:-$HOME/.local/share/mirai-sf-prod}"
export MIRAI_SF_ENV_FILE="${MIRAI_SF_PROD_ENV_FILE:-$HOME/.config/mirai-sf/prod.conf}"
export MIRAI_SF_BACKUP_DIR="${MIRAI_SF_PROD_BACKUP_DIR:-$HOME/.local/state/mirai-sf-prod/backups}"
exec node "$here/with-env.mjs" "$here/restore-drill.sh"
