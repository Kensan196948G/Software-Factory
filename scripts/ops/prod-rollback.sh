#!/usr/bin/env bash
# 本番（Production）のロールバック。DB は戻さない（docs/production/02-runbook.md）。
#
#   scripts/ops/prod-rollback.sh [--dry-run] <commit-sha>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export MIRAI_SF_HOME="${MIRAI_SF_PROD_HOME:-$HOME/.local/share/mirai-sf-prod}"
export MIRAI_SF_ENV_FILE="${MIRAI_SF_PROD_ENV_FILE:-$HOME/.config/mirai-sf/prod.conf}"
export MIRAI_SF_HEALTH_URL="${MIRAI_SF_PROD_HEALTH_URL:-http://127.0.0.1:8783/healthz}"
export MIRAI_SF_API_UNIT="${MIRAI_SF_PROD_API_UNIT:-mirai-sf-prod-api.service}"
export MIRAI_SF_WORKER_UNIT=none

exec bash "$here/rollback.sh" "$@"
