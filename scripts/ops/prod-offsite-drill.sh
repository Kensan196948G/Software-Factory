#!/usr/bin/env bash
# 本番のオフサイト（Cloudflare R2）からの復元訓練。R2 の最新バックアップを取り寄せて復元する。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MIRAI_SF_HOME="${MIRAI_SF_PROD_HOME:-$HOME/.local/share/mirai-sf-prod}"
export MIRAI_SF_ENV_FILE="${MIRAI_SF_PROD_ENV_FILE:-$HOME/.config/mirai-sf/prod.conf}"
export MIRAI_SF_BACKUP_DIR="${MIRAI_SF_PROD_BACKUP_DIR:-$HOME/.local/state/mirai-sf-prod/backups}"
exec node "$here/with-env.mjs" "$here/offsite-drill.mjs"
