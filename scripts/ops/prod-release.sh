#!/usr/bin/env bash
# 本番（Production）の固定リリース。Staging とは別ホーム・別 DB・別 unit で動かす。
#
#   scripts/ops/prod-release.sh [--dry-run] [--no-restart] <commit-sha>
#
# 本番の値はすべて prod.conf（0600）と下記の環境変数から取る。公開ホスト名の作成や
# Cloudflare の設定変更はこのスクリプトでは行わない（ADR §8 の決定後、別作業）。
#
#   MIRAI_SF_PROD_HOME         既定 ~/.local/share/mirai-sf-prod
#   MIRAI_SF_PROD_ENV_FILE     既定 ~/.config/mirai-sf/prod.conf
#   MIRAI_SF_PROD_HEALTH_URL   既定 http://127.0.0.1:8783/healthz
#   MIRAI_SF_PROD_BACKUP_DIR   既定 ~/.local/state/mirai-sf-prod/backups
#   MIRAI_SF_PROD_API_UNIT     既定 mirai-sf-prod-api.service
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export MIRAI_SF_HOME="${MIRAI_SF_PROD_HOME:-$HOME/.local/share/mirai-sf-prod}"
export MIRAI_SF_ENV_FILE="${MIRAI_SF_PROD_ENV_FILE:-$HOME/.config/mirai-sf/prod.conf}"
export MIRAI_SF_HEALTH_URL="${MIRAI_SF_PROD_HEALTH_URL:-http://127.0.0.1:8783/healthz}"
export MIRAI_SF_BACKUP_DIR="${MIRAI_SF_PROD_BACKUP_DIR:-$HOME/.local/state/mirai-sf-prod/backups}"
export MIRAI_SF_API_UNIT="${MIRAI_SF_PROD_API_UNIT:-mirai-sf-prod-api.service}"
# 本番では開発ラインの worker を動かさない（ADR §8-10）
export MIRAI_SF_WORKER_UNIT=none

exec bash "$here/release.sh" "$@"
