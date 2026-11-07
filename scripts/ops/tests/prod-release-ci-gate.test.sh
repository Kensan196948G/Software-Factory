#!/usr/bin/env bash
# prod-release.sh → release.sh の exact-main CI ゲートの単体テスト。
# 実サービス・実 DB・実リポジトリ・GitHub には触らない。一時ディレクトリに
#   - origin がベアリポジトリの git リポジトリ（db/migrations を含む）
#   - 偽 gh（check-release-ci.mjs が呼ぶ 3 つの GET を fixture から返す）
#   - 偽 pnpm（呼ばれたら記録して終了コード 97 で止める = ゲート通過後の展開に到達した印）
#   - 偽 psql（schema_migrations が無い DB を模擬。dry-run の migration 検査用）
# を作り、ゲートの 0 / 75 / 1 の各経路と --dry-run の表示、Staging 単独利用の非適用を検証する。
# ゲート本体は本物の scripts/ops/check-release-ci.mjs を使う（差し替え用の変数は作らない）。
#
# 実行: bash scripts/ops/tests/prod-release-ci-gate.test.sh
# 終了コード: 0=全件成功 / 1=失敗あり
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TEST_DIR/../../.." && pwd)"
PROD_SCRIPT="$ROOT/scripts/ops/prod-release.sh"
RELEASE_SCRIPT="$ROOT/scripts/ops/release.sh"
TMP="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT

pass() { printf 'PASS: %s\n' "$*"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL: %s\n' "$*"; FAIL=$((FAIL + 1)); }
check() {
  local label="$1"
  shift
  if "$@"; then pass "$label"; else fail "$label"; fi
}

assert_code() {
  if [[ "$CODE" == "$1" ]]; then return 0; fi
  printf '  終了コード: 期待 %s / 実際 %s\n' "$1" "$CODE" >&2
  printf '  --- 出力 ---\n%s\n  ----------\n' "$OUT" >&2
  return 1
}
assert_out_contains() {
  if [[ "$OUT" == *"$1"* ]]; then return 0; fi
  printf '  出力に「%s」がありません\n  --- 出力 ---\n%s\n  ----------\n' "$1" "$OUT" >&2
  return 1
}
assert_out_not_contains() {
  if [[ "$OUT" != *"$1"* ]]; then return 0; fi
  printf '  出力に「%s」が出ています\n  --- 出力 ---\n%s\n  ----------\n' "$1" "$OUT" >&2
  return 1
}
# ゲート通過後の展開（pnpm install）に到達していないこと
assert_not_deployed() {
  if [[ ! -s "$CASE/pnpm-invocations" && ! -d "$HOME_DIR/releases/$NEW" ]]; then return 0; fi
  printf '  展開まで進みました（pnpm: %s）\n' "$(cat "$CASE/pnpm-invocations" 2>/dev/null)" >&2
  return 1
}
assert_deploy_reached() {
  if [[ -s "$CASE/pnpm-invocations" ]]; then return 0; fi
  printf '  ゲート通過後の展開（pnpm install）に到達していません\n  --- 出力 ---\n%s\n  ----------\n' "$OUT" >&2
  return 1
}
assert_gh_called() {
  if [[ -s "$CASE/gh-invocations" ]]; then return 0; fi
  printf '  gh（CI 照会）が呼ばれていません\n' >&2
  return 1
}
assert_gh_not_called() {
  if [[ ! -s "$CASE/gh-invocations" ]]; then return 0; fi
  printf '  gh（CI 照会）が呼ばれました: %s\n' "$(head -n 1 "$CASE/gh-invocations")" >&2
  return 1
}
assert_gh_sha() {
  if grep -q "head_sha=$1&" "$CASE/gh-invocations" 2>/dev/null; then return 0; fi
  printf '  gh が完全 SHA %s で照会されていません\n' "$1" >&2
  return 1
}
assert_current_unchanged() {
  local actual
  actual="$(basename "$(readlink "$HOME_DIR/current" 2>/dev/null)" 2>/dev/null)"
  if [[ "$actual" == "$OLD" ]]; then return 0; fi
  printf '  current: 期待 %s / 実際 %s\n' "$OLD" "$actual" >&2
  return 1
}

write_fakes() {
  mkdir -p "$CASE/bin" "$CASE/pgbin" "$CASE/gh"
  # 偽 gh（staging-autofollow.test.sh と同じ流儀）
  cat >"$CASE/bin/gh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CASE/gh-invocations"
if [[ "${FAKE_GH_MODE:-ok}" == error ]]; then
  echo "gh: HTTP 502 SYNTHETIC_MARKER_DO_NOT_LEAK https://example.invalid/x?token=marker" >&2
  exit 1
fi
args="$*"
if [[ "$args" =~ /runs/([0-9]+)/attempts/([0-9]+)/jobs ]]; then
  file="jobs-${BASH_REMATCH[1]}-${BASH_REMATCH[2]}.json"
elif [[ "$args" =~ /runs/([0-9]+)/attempts/([0-9]+) ]]; then
  file="attempt-${BASH_REMATCH[1]}-${BASH_REMATCH[2]}.json"
elif [[ "$args" == *"/actions/workflows/ci.yml/runs"* ]]; then
  file="runs.json"
else
  echo "fake gh: 想定外の引数: $args" >&2
  exit 1
fi
if [[ ! -f "$FAKE_GH_DIR/$file" ]]; then
  echo "fake gh: fixture がありません: $file" >&2
  exit 1
fi
cat "$FAKE_GH_DIR/$file"
EOS
  # 偽 pnpm: 呼ばれた = ゲートを通過して展開に進んだ。ビルドはせず 97 で止める
  cat >"$CASE/bin/pnpm" <<'EOS'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CASE/pnpm-invocations"
exit 97
EOS
  # 偽 psql: schema_migrations が無い DB（未適用 migration = 全件）
  cat >"$CASE/pgbin/psql" <<'EOS'
#!/usr/bin/env bash
printf '\n'
EOS
  chmod +x "$CASE/bin/gh" "$CASE/bin/pnpm" "$CASE/pgbin/psql"
  : >"$CASE/gh-invocations"
  : >"$CASE/pnpm-invocations"
  # 作り物の接続先（実在しない。秘密値ではない）
  printf 'DATABASE_URL=postgresql://fake@127.0.0.1:1/mirai_sf_fake\n' >"$CASE/prod.conf"
  chmod 600 "$CASE/prod.conf"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$CASE/restart-hook.sh"
  chmod +x "$CASE/restart-hook.sh"
  write_gh_success
}

# 既定は「run/attempt success・全必須 job success」（id=2001, attempt=1）
write_gh_success() {
  printf '{"total_count":1,"workflow_runs":[{"id":2001,"run_attempt":1,"head_sha":"%s","event":"push","head_branch":"main","path":".github/workflows/ci.yml","created_at":"2026-11-05T00:00:00Z","status":"completed","conclusion":"success"}]}\n' \
    "$NEW" >"$CASE/gh/runs.json"
  write_gh_attempt completed success
  printf '{"total_count":3,"jobs":[{"name":"quality","status":"completed","conclusion":"success","head_sha":"%s"},{"name":"e2e","status":"completed","conclusion":"success","head_sha":"%s"},{"name":"docker","status":"completed","conclusion":"success","head_sha":"%s"}]}\n' \
    "$NEW" "$NEW" "$NEW" >"$CASE/gh/jobs-2001-1.json"
}

write_gh_attempt() { # <status> <conclusion|null>
  local conclusion="\"$2\""
  [[ "$2" != null ]] || conclusion=null
  printf '{"id":2001,"run_attempt":1,"head_sha":"%s","head_branch":"main","event":"push","path":".github/workflows/ci.yml","status":"%s","conclusion":%s}\n' \
    "$NEW" "$1" "$conclusion" >"$CASE/gh/attempt-2001-1.json"
}

setup_case() { # <name> [home-dir-name]
  GH_MODE=ok
  CASE="$TMP/$1"
  REPO="$CASE/repo"
  ORIGIN="$CASE/origin.git"
  HOME_DIR="$CASE/${2:-mirai-sf-prod}"
  mkdir -p "$HOME_DIR/releases" "$CASE/userhome"
  git init -q --bare "$ORIGIN"
  git init -q -b main "$REPO"
  git -C "$REPO" config user.email "test@example.invalid"
  git -C "$REPO" config user.name "test"
  mkdir -p "$REPO/db/migrations"
  printf 'create table t (id int);\n' >"$REPO/db/migrations/0001_init.sql"
  printf 'v1\n' >"$REPO/version.txt"
  git -C "$REPO" add .
  git -C "$REPO" commit -q -m "chore: v1"
  OLD="$(git -C "$REPO" rev-parse HEAD)"
  printf 'v2\n' >"$REPO/version.txt"
  git -C "$REPO" commit -q -am "feat: v2"
  NEW="$(git -C "$REPO" rev-parse HEAD)"
  git -C "$REPO" remote add origin "$ORIGIN"
  git -C "$REPO" push -q origin main
  mkdir -p "$HOME_DIR/releases/$OLD"
  : >"$HOME_DIR/releases/$OLD/.release-complete"
  ln -s "releases/$OLD" "$HOME_DIR/current"
  write_fakes
}

# 検証用の環境で実行し、OUT と CODE に入れる。
#   run_prod [args...]     prod-release.sh（本番ラッパー）
#   run_release [args...]  release.sh 単独（Staging の手動利用）
common_env() {
  ENV_ARGS=(
    PATH="$CASE/bin:$PATH"
    HOME="$CASE/userhome"
    CASE="$CASE"
    FAKE_GH_DIR="$CASE/gh"
    FAKE_GH_MODE="$GH_MODE"
    MIRAI_SF_REPO="$REPO"
    MIRAI_SF_RESTART_HOOK="$CASE/restart-hook.sh"
    MIRAI_SF_NODE_BIN_DIR="$CASE/no-node"
    MIRAI_SF_PG_BIN_DIR="$CASE/pgbin"
  )
}
run_prod() {
  common_env
  OUT="$(
    env -i "${ENV_ARGS[@]}" \
      ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
      MIRAI_SF_PROD_HOME="$HOME_DIR" \
      MIRAI_SF_PROD_ENV_FILE="$CASE/prod.conf" \
      MIRAI_SF_PROD_HEALTH_URL="http://127.0.0.1:1/healthz" \
      MIRAI_SF_PROD_BACKUP_DIR="$CASE/backups" \
      MIRAI_SF_PROD_API_UNIT="mirai-sf-prod-test-nonexistent.service" \
      bash "$PROD_SCRIPT" "$@" 2>&1
  )"
  CODE=$?
}
run_release() {
  common_env
  OUT="$(
    env -i "${ENV_ARGS[@]}" \
      ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
      MIRAI_SF_HOME="$HOME_DIR" \
      MIRAI_SF_ENV_FILE="$CASE/prod.conf" \
      MIRAI_SF_API_UNIT="mirai-sf-test-nonexistent.service" \
      bash "$RELEASE_SCRIPT" "$@" 2>&1
  )"
  CODE=$?
}
EXTRA_ENV=()

printf '== 静的検査 ==\n'
for f in "$PROD_SCRIPT" "$RELEASE_SCRIPT" "${BASH_SOURCE[0]}"; do
  if bash -n "$f"; then pass "bash -n $(basename "$f")"; else fail "bash -n $(basename "$f")"; fi
done
if command -v shellcheck >/dev/null 2>&1; then
  for f in "$PROD_SCRIPT" "$RELEASE_SCRIPT" "${BASH_SOURCE[0]}"; do
    if shellcheck -x "$f"; then pass "shellcheck $(basename "$f")"; else fail "shellcheck $(basename "$f")"; fi
  done
elif [[ "${CI:-}" == true ]]; then
  # CI では静的検査を省略させない（不在を成功扱いにしない）
  fail "shellcheck が見つかりません（CI=true では必須）"
else
  printf 'SKIP: shellcheck が無いため bash -n のみ（ローカルのみ許容。CI=true では FAIL）\n'
fi

printf '\n== P1. CI 成功（gate=0）なら展開へ進む ==\n'
setup_case gate_ok
run_prod "$NEW"
check "ゲート通過後の展開（偽 pnpm の 97）まで進む" assert_code 97
check "ゲート通過をログに出す" assert_out_contains "exact-main CI ゲートを通過"
check "gate の OK を出す" assert_out_contains "[ci-gate] OK"
check "展開（pnpm install）に到達する" assert_deploy_reached
check "完全 SHA で照会する" assert_gh_sha "$NEW"

printf '\n== P2. 短縮 SHA でも完全 SHA に解決して照会する ==\n'
setup_case gate_short
run_prod "${NEW:0:12}"
check "短縮 SHA でもゲート通過後の展開まで進む" assert_code 97
check "完全 SHA（40 桁）で照会する" assert_gh_sha "$NEW"

printf '\n== P3. CI 未完了（gate=75）なら配備しない ==\n'
setup_case gate_pending
write_gh_attempt in_progress null
run_prod "$NEW"
check "CI 未完了は終了コード 75" assert_code 75
check "CI 未完了は展開しない" assert_not_deployed
check "CI 未完了は current を変えない" assert_current_unchanged
check "未確認をログに出す" assert_out_contains "exact-main CI が未確認のため配備しません"

printf '\n== P3b. CI が cancelled（後続に置換）なら「未確認」（gate=75）で配備しない ==\n'
setup_case gate_cancelled
write_gh_attempt completed cancelled
run_prod "$NEW"
check "CI cancelled は終了コード 75" assert_code 75
check "CI cancelled は展開しない" assert_not_deployed
check "CI cancelled は current を変えない" assert_current_unchanged
check "未確認をログに出す" assert_out_contains "exact-main CI が未確認のため配備しません"

printf '\n== P3c. CI が skipped（意図的に未実行）なら失敗（gate=1）として通知する ==\n'
setup_case gate_skipped
write_gh_attempt completed skipped
run_prod "$NEW"
check "CI skipped は終了コード 1" assert_code 1
check "CI skipped は展開しない" assert_not_deployed
check "失敗をログに出す" assert_out_contains "exact-main CI が失敗または照会不能のため配備しません"

printf '\n== P3d. CI が stale（後続に置換）なら「未確認」（gate=75）で配備しない ==\n'
setup_case gate_stale
write_gh_attempt completed stale
run_prod "$NEW"
check "CI stale は終了コード 75" assert_code 75
check "CI stale は展開しない" assert_not_deployed
check "CI stale は current を変えない" assert_current_unchanged
check "未確認をログに出す" assert_out_contains "exact-main CI が未確認のため配備しません"

printf '\n== P4. CI の run が無い（gate=75）なら配備しない ==\n'
setup_case gate_norun
printf '{"total_count":0,"workflow_runs":[]}\n' >"$CASE/gh/runs.json"
run_prod "$NEW"
check "run なしは終了コード 75" assert_code 75
check "run なしは展開しない" assert_not_deployed

printf '\n== P5. CI 失敗（gate=1）なら配備しない ==\n'
setup_case gate_failure
write_gh_attempt completed failure
run_prod "$NEW"
check "CI 失敗は終了コード 1" assert_code 1
check "CI 失敗は展開しない" assert_not_deployed
check "CI 失敗は current を変えない" assert_current_unchanged
check "失敗をログに出す" assert_out_contains "exact-main CI が失敗または照会不能のため配備しません"

printf '\n== P6. gh/API エラー（gate=1）なら配備しない ==\n'
setup_case gate_error
GH_MODE=error
run_prod "$NEW"
check "API エラーは終了コード 1" assert_code 1
check "API エラーは展開しない" assert_not_deployed
check "gh の stderr 本文（マーカー）を出さない" assert_out_not_contains "SYNTHETIC_MARKER_DO_NOT_LEAK"

printf '\n== P7. 呼び出し元が MIRAI_SF_RELEASE_CI_GATE=0 でも本番はゲートを外せない ==\n'
setup_case gate_nobypass
write_gh_attempt completed failure
EXTRA_ENV=(MIRAI_SF_RELEASE_CI_GATE=0)
run_prod "$NEW"
EXTRA_ENV=()
check "0 を渡しても CI 失敗は終了コード 1" assert_code 1
check "0 を渡しても展開しない" assert_not_deployed
check "0 を渡しても CI を照会する" assert_gh_called

printf '\n== P8. --dry-run は CI 失敗でも結果を表示するだけ ==\n'
setup_case dry_failure
write_gh_attempt completed failure
run_prod --dry-run "$NEW"
check "dry-run は終了コード 0（migration 検査の結果）" assert_code 0
check "dry-run でも CI を照会する" assert_gh_called
check "dry-run はゲート失敗を表示する" assert_out_contains "[dry-run] exact-main CI ゲート: 失敗または照会不能（exit 1）"
check "dry-run は展開しない" assert_not_deployed
check "dry-run は計画を表示する" assert_out_contains "[dry-run] 計画"

printf '\n== P9. --dry-run は CI 未完了を表示する ==\n'
setup_case dry_pending
write_gh_attempt in_progress null
run_prod --dry-run "$NEW"
check "dry-run（未完了）は終了コード 0" assert_code 0
check "dry-run は未確認（75）を表示する" assert_out_contains "[dry-run] exact-main CI ゲート: 未確認（exit 75）"

printf '\n== P10. --dry-run は CI 成功を表示する ==\n'
setup_case dry_ok
run_prod --dry-run "$NEW"
check "dry-run（成功）は終了コード 0" assert_code 0
check "dry-run は確認済みを表示する" assert_out_contains "[dry-run] exact-main CI ゲート: 確認済み（exit 0）"
check "dry-run（成功）でも展開しない" assert_not_deployed

printf '\n== P11. Staging の release.sh 単独利用はゲートを実行しない（従来どおり） ==\n'
setup_case staging_plain mirai-sf-staging-test
GH_MODE=error
run_release "$NEW"
check "Staging 単独はゲートなしで展開へ進む（偽 pnpm の 97）" assert_code 97
check "Staging 単独は CI を照会しない" assert_gh_not_called
check "Staging 単独はゲートのログを出さない" assert_out_not_contains "exact-main CI"
check "Staging 単独は展開に到達する" assert_deploy_reached

printf '\n== P12. 本番ホーム（*-prod）を release.sh で直接使ってもゲートは有効 ==\n'
setup_case prod_direct mirai-sf-prod
write_gh_attempt completed failure
EXTRA_ENV=(MIRAI_SF_RELEASE_CI_GATE=0)
run_release "$NEW"
EXTRA_ENV=()
check "本番ホーム直接でも CI 失敗は終了コード 1" assert_code 1
check "本番ホーム直接でも展開しない" assert_not_deployed

printf '\n== P13. main に含まれない commit はゲート前に止める ==\n'
setup_case not_main
git -C "$REPO" checkout -q -b feature
printf 'x\n' >"$REPO/feature.txt"
git -C "$REPO" add feature.txt
git -C "$REPO" commit -q -m "feat: feature only"
FEATURE="$(git -C "$REPO" rev-parse HEAD)"
run_prod "$FEATURE"
check "main 外は終了コード 1" assert_code 1
check "main 外は CI を照会しない" assert_gh_not_called
check "main 外をログに出す" assert_out_contains "main に含まれない commit"

printf '\n== 結果: PASS %d / FAIL %d ==\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]]
