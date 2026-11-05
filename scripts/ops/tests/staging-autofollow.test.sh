#!/usr/bin/env bash
# staging-autofollow.sh の単体テスト。
# 実サービス・実 DB・実リポジトリには触らない。一時ディレクトリに
#   - origin がベアリポジトリの git リポジトリ
#   - 偽の release.sh / rollback.sh（current の切替と /healthz の応答を模擬）
#   - 偽の /healthz サーバー
# を作り、no-op・配備・health 不一致・多重実行などを検証する。
#
# 実行: bash scripts/ops/tests/staging-autofollow.test.sh
# 終了コード: 0=全件成功 / 1=失敗あり
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TEST_DIR/../../.." && pwd)"
SCRIPT="$ROOT/scripts/ops/staging-autofollow.sh"
GATE="$ROOT/scripts/ops/check-release-ci.mjs"
TMP="$(mktemp -d)"
HEALTH_FILE="$TMP/health.json"
SERVER_PID=""
GH_MODE="ok"
OTHER_SHA="1111111111111111111111111111111111111111"
PASS=0
FAIL=0

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf -- "$TMP"
}
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
  printf '  出力に「%s」が出ています（漏えい）\n  --- 出力 ---\n%s\n  ----------\n' "$1" "$OUT" >&2
  return 1
}
assert_no_release() {
  if [[ ! -s "$CASE/release-invocations" ]]; then return 0; fi
  printf '  release.sh が呼ばれました: %s\n' "$(cat "$CASE/release-invocations")" >&2
  return 1
}
assert_release_called_with() {
  if grep -qx "$1" "$CASE/release-invocations" 2>/dev/null; then return 0; fi
  printf '  release.sh が %s で呼ばれていません\n' "$1" >&2
  return 1
}
assert_rollback_called_with() {
  if grep -qx "$1" "$CASE/rollback-invocations" 2>/dev/null; then return 0; fi
  printf '  rollback.sh が %s で呼ばれていません\n' "$1" >&2
  return 1
}
assert_current() {
  local actual
  actual="$(basename "$(readlink "$HOME_DIR/current" 2>/dev/null)" 2>/dev/null)"
  if [[ "$actual" == "$1" ]]; then return 0; fi
  printf '  current: 期待 %s / 実際 %s\n' "$1" "$actual" >&2
  return 1
}
assert_release_dir() {
  if [[ -d "$HOME_DIR/releases/$1" ]]; then return 0; fi
  printf '  リリースが残っていません: %s\n' "$1" >&2
  return 1
}
assert_no_release_dir() {
  if [[ ! -d "$HOME_DIR/releases/$1" ]]; then return 0; fi
  printf '  リリースが残っています: %s\n' "$1" >&2
  return 1
}
assert_release_count() {
  local actual
  actual="$(find "$HOME_DIR/releases" -mindepth 1 -maxdepth 1 -type d | wc -l)"
  if [[ "$actual" -eq "$1" ]]; then return 0; fi
  printf '  リリース数: 期待 %s / 実際 %s\n' "$1" "$actual" >&2
  return 1
}
assert_health_commit() {
  local actual
  actual="$(node -e 'try { console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).commit ?? ""); } catch { console.log(""); }' "$HEALTH_FILE")"
  if [[ "$actual" == "$1" ]]; then return 0; fi
  printf '  healthz の commit: 期待 %s / 実際 %s\n' "$1" "$actual" >&2
  return 1
}
assert_repo_head() {
  local actual
  actual="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$actual" == "$1" ]]; then return 0; fi
  printf '  実行元の HEAD: 期待 %s / 実際 %s\n' "$1" "$actual" >&2
  return 1
}

write_health() { # <sha> <db.ok: true|false>
  printf '{"status":"ok","environment":"staging","commit":"%s","db":{"ok":%s}}' "$1" "$2" >"$HEALTH_FILE"
}

# 偽の release.sh / rollback.sh を作る。CASE / HOME_DIR / HEALTH_FILE は env で渡す。
write_fakes() {
  cat >"$CASE/fake-release.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
sha="$1"
printf '%s\n' "$sha" >>"$CASE/release-invocations"
# 本番用 CI ゲートの有効化変数が release.sh へ渡っていないかを記録する
printf '%s\n' "${MIRAI_SF_RELEASE_CI_GATE-unset}" >>"$CASE/release-ci-gate-env"
mode="${FAKE_RELEASE_MODE:-ok}"
if [[ "$mode" == "fail" ]]; then
  echo "fake release: ビルド失敗を模擬" >&2
  exit 1
fi
mkdir -p "$HOME_DIR/releases/$sha"
printf 'COMMIT_SHA=%s\n' "$sha" >"$HOME_DIR/releases/$sha/release.env"
: >"$HOME_DIR/releases/$sha/.release-complete"
ln -sfn "releases/$sha" "$HOME_DIR/.current.tmp"
mv -T "$HOME_DIR/.current.tmp" "$HOME_DIR/current"
if [[ "$mode" == "ok" ]]; then
  printf '{"status":"ok","environment":"staging","commit":"%s","db":{"ok":true}}' "$sha" >"$HEALTH_FILE"
elif [[ "$mode" == "db-fail" ]]; then
  printf '{"status":"ok","environment":"staging","commit":"%s","db":{"ok":false}}' "$sha" >"$HEALTH_FILE"
elif [[ "$mode" == "wrong-env" ]]; then
  printf '{"status":"ok","environment":"production","commit":"%s","db":{"ok":true}}' "$sha" >"$HEALTH_FILE"
fi
# bad-health: 切替だけして /healthz は前の commit のまま（= 不一致）
exit 0
EOS
  cat >"$CASE/fake-rollback.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
sha="$1"
printf '%s\n' "$sha" >>"$CASE/rollback-invocations"
if [[ ! -d "$HOME_DIR/releases/$sha" ]]; then
  echo "fake rollback: リリースがありません $sha" >&2
  exit 1
fi
ln -sfn "releases/$sha" "$HOME_DIR/.current.tmp"
mv -T "$HOME_DIR/.current.tmp" "$HOME_DIR/current"
printf '{"status":"ok","environment":"staging","commit":"%s","db":{"ok":true}}' "$sha" >"$HEALTH_FILE"
exit 0
EOS
  chmod +x "$CASE/fake-release.sh" "$CASE/fake-rollback.sh"

  # 偽 gh。gate が呼ぶ 3 つの GET（runs / attempts/{n} / jobs）を fixture から返す。
  mkdir -p "$CASE/bin" "$CASE/gh"
  cat >"$CASE/bin/gh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FAKE_GH_MODE:-ok}" == error ]]; then
  # 合成マーカー。gate が stderr 本文を返すとテストが検出する（実秘密ではない）。
  echo "gh: HTTP 502 SYNTHETIC_MARKER_DO_NOT_LEAK https://example.invalid/x?token=marker" >&2
  exit 1
fi
args="$*"
if [[ "$args" =~ /runs/([0-9]+)/attempts/([0-9]+)/jobs ]]; then
  file="jobs-${BASH_REMATCH[1]}-${BASH_REMATCH[2]}.json"
elif [[ "$args" =~ /runs/([0-9]+)/attempts/([0-9]+) ]]; then
  file="attempt-${BASH_REMATCH[1]}-${BASH_REMATCH[2]}.json"
elif [[ "$args" == *"/actions/workflows/ci.yml/runs"* ]]; then
  calls=0
  if [[ -f "$FAKE_GH_DIR/runs-calls" ]]; then calls="$(cat "$FAKE_GH_DIR/runs-calls")"; fi
  calls=$((calls + 1))
  printf '%s\n' "$calls" >"$FAKE_GH_DIR/runs-calls"
  if [[ "$calls" -ge 2 && -f "$FAKE_GH_DIR/runs-after.json" ]]; then
    file="runs-after.json"
  else
    file="runs.json"
  fi
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
  chmod +x "$CASE/bin/gh"
  write_gh_default
}

# 既定は「全 job success / run success」の 1 run（id=1001, attempt=1）。
write_gh_default() {
  write_gh_run "$NEW" push main 1 1001
  cat >"$CASE/gh/attempt-1001-1.json" <<EOF
{"id":1001,"head_sha":"$NEW","head_branch":"main","event":"push","path":".github/workflows/ci.yml","status":"completed","conclusion":"success","run_attempt":1}
EOF
  cat >"$CASE/gh/jobs-1001-1.json" <<EOF
{"total_count":3,"jobs":[{"name":"quality","status":"completed","conclusion":"success","head_sha":"$NEW"},{"name":"e2e","status":"completed","conclusion":"success","head_sha":"$NEW"},{"name":"docker","status":"completed","conclusion":"success","head_sha":"$NEW"}]}
EOF
}

write_gh_run() { # <sha> <event> <branch> [attempt] [id]
  printf '{"total_count":1,"workflow_runs":[{"id":%s,"run_attempt":%s,"head_sha":"%s","event":"%s","head_branch":"%s","path":".github/workflows/ci.yml","created_at":"2026-11-04T00:00:00Z","status":"completed","conclusion":"success"}]}\n' \
    "${5:-1001}" "${4:-1}" "$1" "$2" "$3" >"$CASE/gh/runs.json"
}

write_gh_jobs() { # <id> <attempt> <quality conclusion> <e2e conclusion> <docker conclusion|omit>
  local docker="${5:-success}"
  if [[ "$docker" == "omit" ]]; then
    printf '{"total_count":2,"jobs":[{"name":"quality","status":"completed","conclusion":"%s","head_sha":"%s"},{"name":"e2e","status":"completed","conclusion":"%s","head_sha":"%s"}]}\n' \
      "$3" "$NEW" "$4" "$NEW" >"$CASE/gh/jobs-$1-$2.json"
  else
    printf '{"total_count":3,"jobs":[{"name":"quality","status":"completed","conclusion":"%s","head_sha":"%s"},{"name":"e2e","status":"completed","conclusion":"%s","head_sha":"%s"},{"name":"docker","status":"completed","conclusion":"%s","head_sha":"%s"}]}\n' \
      "$3" "$NEW" "$4" "$NEW" "$docker" "$NEW" >"$CASE/gh/jobs-$1-$2.json"
  fi
}

setup_case() { # <name>
  GH_MODE="ok"
  CASE="$TMP/$1"
  REPO="$CASE/repo"
  ORIGIN="$CASE/origin.git"
  HOME_DIR="$CASE/home"
  mkdir -p "$HOME_DIR/releases" "$CASE/state"
  git init -q --bare "$ORIGIN"
  git init -q -b main "$REPO"
  git -C "$REPO" config user.email "test@example.invalid"
  git -C "$REPO" config user.name "test"
  printf 'v1\n' >"$REPO/version.txt"
  git -C "$REPO" add version.txt
  git -C "$REPO" commit -q -m "chore: v1"
  OLD="$(git -C "$REPO" rev-parse HEAD)"
  printf 'v2\n' >"$REPO/version.txt"
  git -C "$REPO" commit -q -am "feat: v2"
  NEW="$(git -C "$REPO" rev-parse HEAD)"
  git -C "$REPO" remote add origin "$ORIGIN"
  git -C "$REPO" push -q origin main
  git -C "$REPO" fetch -q origin main
  mkdir -p "$HOME_DIR/releases/$OLD"
  printf 'COMMIT_SHA=%s\n' "$OLD" >"$HOME_DIR/releases/$OLD/release.env"
  : >"$HOME_DIR/releases/$OLD/.release-complete"
  ln -s "releases/$OLD" "$HOME_DIR/current"
  write_health "$OLD" true
  : >"$CASE/release-invocations"
  : >"$CASE/rollback-invocations"
  write_fakes
}

# 検証用の環境で autofollow を実行し、OUT と CODE に入れる。
run_case() { # <FAKE_RELEASE_MODE> [script args...]
  local mode="$1"
  shift
  OUT="$(
    env -i \
      PATH="$CASE/bin:$PATH" \
      HOME="$HOME_DIR" \
      FAKE_GH_DIR="$CASE/gh" \
      FAKE_GH_MODE="$GH_MODE" \
      CASE="$CASE" \
      HOME_DIR="$HOME_DIR" \
      HEALTH_FILE="$HEALTH_FILE" \
      FAKE_RELEASE_MODE="$mode" \
      MIRAI_SF_HOME="$HOME_DIR" \
      MIRAI_SF_REPO="$REPO" \
      MIRAI_SF_HEALTH_URL="http://127.0.0.1:$PORT/healthz" \
      MIRAI_SF_RELEASE_SCRIPT="$CASE/fake-release.sh" \
      MIRAI_SF_ROLLBACK_SCRIPT="$CASE/fake-rollback.sh" \
      MIRAI_SF_AUTOFOLLOW_STATE_FILE="$CASE/state/autofollow.json" \
      MIRAI_SF_AUTOFOLLOW_HEALTH_RETRIES=2 \
      MIRAI_SF_NODE_BIN_DIR="$CASE/no-node" \
      ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
      bash "$SCRIPT" "$@" 2>&1
  )"
  CODE=$?
}
EXTRA_ENV=()

printf '== 静的検査 ==\n'
if bash -n "$SCRIPT"; then pass "bash -n staging-autofollow.sh"; else fail "bash -n staging-autofollow.sh"; fi
if bash -n "${BASH_SOURCE[0]}"; then pass "bash -n テストスクリプト"; else fail "bash -n テストスクリプト"; fi
if node --check "$GATE"; then pass "node --check check-release-ci.mjs"; else fail "node --check check-release-ci.mjs"; fi
if node "$GATE" >/dev/null 2>&1; then
  fail "引数なしの gate は終了コード 1"
else
  if [[ "$?" -eq 1 ]]; then pass "引数なしの gate は終了コード 1"; else fail "引数なしの gate は終了コード 1"; fi
fi
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -x "$SCRIPT"; then pass "shellcheck staging-autofollow.sh"; else fail "shellcheck staging-autofollow.sh"; fi
  if shellcheck -x "${BASH_SOURCE[0]}"; then pass "shellcheck テストスクリプト"; else fail "shellcheck テストスクリプト"; fi
else
  printf 'SKIP: shellcheck が無いため bash -n のみ\n'
fi

printf '\n== 偽 /healthz サーバー ==\n'
PORT="$(
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      console.log(server.address().port);
      server.close();
    });
  '
)"
node "$TEST_DIR/fake-health-server.mjs" "$PORT" "$HEALTH_FILE" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
SERVER_READY=0
for _ in $(seq 1 100); do
  if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    SERVER_READY=1
    break
  fi
  sleep 0.05
done
if [[ "$SERVER_READY" == 1 ]]; then pass "偽 /healthz サーバー起動（port $PORT）"; else fail "偽 /healthz サーバー起動"; fi

printf '\n== 1. 同一 commit は no-op ==\n'
setup_case noop
ln -sfn "releases/$NEW" "$HOME_DIR/current"
write_health "$NEW" true
run_case ok
check "同一 commit で終了コード 0" assert_code 0
check "release.sh を呼ばない" assert_no_release
check "no-op をログに出す" assert_out_contains "no-op"

printf '\n== 2. 更新があれば配備する ==\n'
setup_case deploy
run_case ok
check "配備成功で終了コード 0" assert_code 0
check "origin/main の commit で release.sh を呼ぶ" assert_release_called_with "$NEW"
check "current が新しい commit になる" assert_current "$NEW"
check "healthz が新しい commit になる" assert_health_commit "$NEW"
check "exact-main CI ゲートを通過する" assert_out_contains "[ci-gate] OK"

printf '\n== 2b. controller が origin/main より遅れていても checkout を変更せず配備する ==\n'
setup_case behind
git -C "$REPO" reset -q --hard "$OLD"
run_case ok
check "遅れていても配備成功で終了コード 0" assert_code 0
check "controller 分離をログに出す" assert_out_contains "実行元は変更しません"
check "origin/main の commit で release.sh を呼ぶ" assert_release_called_with "$NEW"
check "controller の HEAD は元のまま" assert_repo_head "$OLD"
check "current が新しい commit になる" assert_current "$NEW"

printf '\n== 3. 配備後の health 不一致は失敗し、直前へ戻す ==\n'
setup_case badhealth
run_case bad-health
check "health 不一致で終了コード 1" assert_code 1
check "直前のリリースへ rollback する" assert_rollback_called_with "$OLD"
check "current が直前の commit に戻る" assert_current "$OLD"
check "失敗をログに出す" assert_out_contains "配備後の確認に失敗"

printf '\n== 4. 追従済みでも db.ok=false は異常 ==\n'
setup_case dbfail
ln -sfn "releases/$NEW" "$HOME_DIR/current"
write_health "$NEW" false
run_case ok
check "db.ok=false で終了コード 1" assert_code 1
check "release.sh を呼ばない" assert_no_release
check "healthz の不一致をログに出す" assert_out_contains "healthz が一致しません"

printf '\n== 5. 多重実行防止（flock） ==\n'
setup_case multilock
(
  exec 8>"$HOME_DIR/.autofollow.lock"
  flock 8
  : >"$CASE/locked"
  sleep 20
) &
LOCK_PID=$!
for _ in $(seq 1 200); do
  [[ -f "$CASE/locked" ]] && break
  sleep 0.05
done
run_case ok
check "ロック中は終了コード 75" assert_code 75
check "ロック中は release.sh を呼ばない" assert_no_release
check "スキップをログに出す" assert_out_contains "別の autofollow が実行中"
kill "$LOCK_PID" 2>/dev/null || true
wait "$LOCK_PID" 2>/dev/null || true

printf '\n== 6. ドライランは配備しない ==\n'
setup_case dryrun
run_case ok --dry-run
check "dry-run で終了コード 0" assert_code 0
check "dry-run では release.sh を呼ばない" assert_no_release
check "更新ありを表示する" assert_out_contains "[dry-run] 更新あり"

printf '\n== 7. release.sh の失敗は戻して終了コード 1 ==\n'
setup_case releasefail
run_case fail
check "release 失敗で終了コード 1" assert_code 1
check "current は元のまま" assert_current "$OLD"
check "release 失敗をログに出す" assert_out_contains "release.sh が失敗"

printf '\n== 8. 不正なオプション ==\n'
setup_case usage
run_case ok --bogus
check "不正なオプションで終了コード 1" assert_code 1
check "使い方を出す" assert_out_contains "不明なオプション"

printf '\n== 9. 手動の release/rollback 中は触らない（.ops.lock） ==\n'
setup_case opslock
git -C "$REPO" reset -q --hard "$OLD"
(
  exec 9>"$HOME_DIR/.ops.lock"
  flock 9
  : >"$CASE/ops-locked"
  sleep 20
) &
OPS_LOCK_PID=$!
for _ in $(seq 1 200); do
  [[ -f "$CASE/ops-locked" ]] && break
  sleep 0.05
done
run_case ok
check "手動 release 中は終了コード 75" assert_code 75
check "手動 release 中は release.sh を呼ばない" assert_no_release
check "手動 release 中はスキップをログに出す" assert_out_contains "手動の release/rollback が実行中"
check "手動 release 中は CI も照会しない" assert_out_not_contains "[ci-gate]"
check "手動 release 中は controller を変更しない" assert_repo_head "$OLD"
kill "$OPS_LOCK_PID" 2>/dev/null || true
wait "$OPS_LOCK_PID" 2>/dev/null || true

printf '\n== 10. 実行元が main でない場合は配備しない ==\n'
setup_case branch
git -C "$REPO" checkout -q -b feature
run_case ok
check "main 以外では終了コード 75" assert_code 75
check "main 以外では release.sh を呼ばない" assert_no_release
check "main 以外をログに出す" assert_out_contains "main・clean ではありません"

printf '\n== 11. 実行元が汚れている場合は配備しない ==\n'
setup_case dirty
: >"$REPO/dirty.txt"
run_case ok
check "未コミットの変更があると終了コード 75" assert_code 75
check "未コミットの変更があると release.sh を呼ばない" assert_no_release
check "未コミットの変更をログに出す" assert_out_contains "main・clean ではありません"

printf '\n== 12. environment が staging でない health は失敗 ==\n'
setup_case wrongenv
run_case wrong-env
check "environment 不一致で終了コード 1" assert_code 1
check "直前のリリースへ rollback する" assert_rollback_called_with "$OLD"
check "current が直前の commit に戻る" assert_current "$OLD"
check "配備後の確認失敗をログに出す" assert_out_contains "配備後の確認に失敗"

printf '\n== 13. 成功後に古い releases を整理する ==\n'
setup_case prune
for i in 1 2 3 4 5 6 7 8; do
  sha="$(printf '%040x' "$i")"
  mkdir -p "$HOME_DIR/releases/$sha"
  : >"$HOME_DIR/releases/$sha/.release-complete"
  printf 'COMMIT_SHA=%s\n' "$sha" >"$HOME_DIR/releases/$sha/release.env"
  touch -d "2026-01-0$i 00:00:00" "$HOME_DIR/releases/$sha"
done
run_case ok
check "配備成功で終了コード 0" assert_code 0
check "current が新しい commit になる" assert_current "$NEW"
check "直近5世代は残る（4〜8）" assert_release_dir "$(printf '%040x' 4)"
check "直近5世代は残る（8）" assert_release_dir "$(printf '%040x' 8)"
check "古い世代は削除される（1）" assert_no_release_dir "$(printf '%040x' 1)"
check "古い世代は削除される（3）" assert_no_release_dir "$(printf '%040x' 3)"
check "current/previous も残る" assert_release_dir "$OLD"
check "リリース数は 7（current/previous + 5）" assert_release_count 7
check "整理をログに出す" assert_out_contains "releases を整理"

printf '\n== 14. 別 SHA の CI は通さない ==\n'
setup_case gate_sha
write_gh_run "$OTHER_SHA" push main
run_case ok
check "別 SHA は終了コード 75" assert_code 75
check "別 SHA は release.sh を呼ばない" assert_no_release
check "別 SHA をログに出す" assert_out_contains "[ci-gate] 未確認"

printf '\n== 15. event が push でない CI は通さない ==\n'
setup_case gate_event
write_gh_run "$NEW" pull_request main
run_case ok
check "event 不一致は終了コード 1" assert_code 1
check "event 不一致は release.sh を呼ばない" assert_no_release
check "event 不一致をログに出す" assert_out_contains "event/branch/path が一致しません"

printf '\n== 16. branch が main でない CI は通さない ==\n'
setup_case gate_branch
write_gh_run "$NEW" push feature
run_case ok
check "branch 不一致は終了コード 1" assert_code 1
check "branch 不一致は release.sh を呼ばない" assert_no_release
check "branch 不一致をログに出す" assert_out_contains "event/branch/path が一致しません"

printf '\n== 17. 過去 attempt が success でも最新 attempt が未完了なら通さない ==\n'
setup_case gate_attempt
write_gh_run "$NEW" push main 2 1001
cat >"$CASE/gh/attempt-1001-1.json" <<EOF
{"id":1001,"head_sha":"$NEW","head_branch":"main","event":"push","path":".github/workflows/ci.yml","status":"completed","conclusion":"success","run_attempt":1}
EOF
cat >"$CASE/gh/attempt-1001-2.json" <<EOF
{"id":1001,"head_sha":"$NEW","head_branch":"main","event":"push","path":".github/workflows/ci.yml","status":"in_progress","conclusion":null,"run_attempt":2}
EOF
write_gh_jobs 1001 2 success success success
run_case ok
check "最新 attempt 未完了は終了コード 75" assert_code 75
check "最新 attempt 未完了は release.sh を呼ばない" assert_no_release
check "未完了をログに出す" assert_out_contains "未完了"

printf '\n== 18. 必須 job が skipped なら通さない ==\n'
setup_case gate_skip
write_gh_jobs 1001 1 success skipped success
run_case ok
check "job skipped は終了コード 1" assert_code 1
check "job skipped は release.sh を呼ばない" assert_no_release
check "skipped をログに出す" assert_out_contains "e2e"

printf '\n== 19. 必須 job が欠けていれば通さない ==\n'
setup_case gate_missing
write_gh_jobs 1001 1 success success omit
run_case ok
check "job 欠落は終了コード 1" assert_code 1
check "job 欠落は release.sh を呼ばない" assert_no_release
check "欠落 job をログに出す" assert_out_contains "必須 job がありません: docker"

printf '\n== 20. gh/API エラーは終了コード 1（75 ではない） ==\n'
setup_case gate_error
GH_MODE=error
run_case ok
check "API エラーは終了コード 1" assert_code 1
check "API エラーは release.sh を呼ばない" assert_no_release
check "API エラーをログに出す" assert_out_contains "照会エラー"
check "gh の stderr 本文（マーカー）を出さない" assert_out_not_contains "SYNTHETIC_MARKER_DO_NOT_LEAK"

printf '\n== 21. run が failure なら通さない ==\n'
setup_case gate_failed
cat >"$CASE/gh/attempt-1001-1.json" <<EOF
{"id":1001,"head_sha":"$NEW","head_branch":"main","event":"push","path":".github/workflows/ci.yml","status":"completed","conclusion":"failure","run_attempt":1}
EOF
run_case ok
check "run failure は終了コード 1" assert_code 1
check "run failure は release.sh を呼ばない" assert_no_release
check "failure をログに出す" assert_out_contains "成功していません"

printf '\n== 22. 必須 job が未完了なら通さない ==\n'
setup_case gate_job_pending
cat >"$CASE/gh/jobs-1001-1.json" <<EOF
{"total_count":3,"jobs":[{"name":"quality","status":"in_progress","conclusion":null,"head_sha":"$NEW"},{"name":"e2e","status":"completed","conclusion":"success","head_sha":"$NEW"},{"name":"docker","status":"completed","conclusion":"success","head_sha":"$NEW"}]}
EOF
run_case ok
check "job 未完了は終了コード 75" assert_code 75
check "job 未完了は release.sh を呼ばない" assert_no_release
check "job 未完了をログに出す" assert_out_contains "quality"

printf '\n== 23. 実行元が diverged（local commits）なら通さない ==\n'
setup_case gate_head
git -C "$REPO" reset -q --hard "$OLD"
printf 'local\n' >"$REPO/local.txt"
git -C "$REPO" add local.txt
git -C "$REPO" commit -q -m "local only"
run_case ok
check "diverged は終了コード 75" assert_code 75
check "diverged は release.sh を呼ばない" assert_no_release
check "diverged をログに出す" assert_out_contains "祖先ではありません"

printf '\n== 24. exact SHA の run が無ければ通さない ==\n'
setup_case gate_norun
printf '{"total_count":0,"workflow_runs":[]}\n' >"$CASE/gh/runs.json"
run_case ok
check "run なしは終了コード 75" assert_code 75
check "run なしは release.sh を呼ばない" assert_no_release
check "run なしをログに出す" assert_out_contains "run がありません"

printf '\n== 25. run.path が欠落した応答は通さない（fail-closed） ==\n'
setup_case gate_nopath
cat >"$CASE/gh/runs.json" <<EOF
{"total_count":1,"workflow_runs":[{"id":1001,"run_attempt":1,"head_sha":"$NEW","event":"push","head_branch":"main","created_at":"2026-11-04T00:00:00Z","status":"completed","conclusion":"success"}]}
EOF
run_case ok
check "path 欠落は終了コード 1" assert_code 1
check "path 欠落は release.sh を呼ばない" assert_no_release
check "path 欠落をログに出す" assert_out_contains "run メタデータが不完全"

printf '\n== 26. attempt のメタデータが一覧と一致しなければ通さない ==\n'
setup_case gate_attempt_meta
cat >"$CASE/gh/attempt-1001-1.json" <<EOF
{"id":1001,"head_sha":"$NEW","head_branch":"main","event":"push","path":".github/workflows/ci.yml","status":"completed","conclusion":"success","run_attempt":2}
EOF
run_case ok
check "attempt メタデータ不一致は終了コード 1" assert_code 1
check "attempt メタデータ不一致は release.sh を呼ばない" assert_no_release
check "メタデータ不一致をログに出す" assert_out_contains "一致しません"

printf '\n== 27. job 確認後に新しい attempt が現れたら通さない（再 run race） ==\n'
setup_case gate_rerun
cat >"$CASE/gh/runs-after.json" <<EOF
{"total_count":1,"workflow_runs":[{"id":1001,"run_attempt":2,"head_sha":"$NEW","event":"push","head_branch":"main","path":".github/workflows/ci.yml","created_at":"2026-11-04T00:00:00Z","status":"in_progress","conclusion":null}]}
EOF
run_case ok
check "再 run race は終了コード 75" assert_code 75
check "再 run race は release.sh を呼ばない" assert_no_release
check "再 run race をログに出す" assert_out_contains "再確認で不一致"

printf '\n== 28. API 情報不足（attempt に必要な項目が無い）は 1 ==\n'
setup_case gate_info
cat >"$CASE/gh/attempt-1001-1.json" <<EOF
{"id":1001,"head_sha":"$NEW","head_branch":"main","status":"completed","conclusion":"success","run_attempt":1}
EOF
run_case ok
check "API 情報不足は終了コード 1" assert_code 1
check "API 情報不足は release.sh を呼ばない" assert_no_release
check "API 情報不足をログに出す" assert_out_contains "一致しません"

printf '\n== 29. created_at が欠落した run は最新を決められないので通さない ==\n'
setup_case gate_no_created
cat >"$CASE/gh/runs.json" <<EOF
{"total_count":2,"workflow_runs":[
  {"id":1002,"run_attempt":1,"head_sha":"$NEW","event":"push","head_branch":"main","path":".github/workflows/ci.yml","status":"in_progress","conclusion":null},
  {"id":1001,"run_attempt":1,"head_sha":"$NEW","event":"push","head_branch":"main","path":".github/workflows/ci.yml","created_at":"2026-11-04T00:00:00Z","status":"completed","conclusion":"success"}
]}
EOF
run_case ok
check "created_at 欠落は終了コード 1" assert_code 1
check "created_at 欠落は release.sh を呼ばない" assert_no_release
check "created_at 欠落をログに出す" assert_out_contains "created_at が不正"

printf '\n== 30. job の head_sha が欠落したら通さない ==\n'
setup_case gate_job_nosha
cat >"$CASE/gh/jobs-1001-1.json" <<EOF
{"total_count":3,"jobs":[{"name":"quality","status":"completed","conclusion":"success"},{"name":"e2e","status":"completed","conclusion":"success","head_sha":"$NEW"},{"name":"docker","status":"completed","conclusion":"success","head_sha":"$NEW"}]}
EOF
run_case ok
check "job head_sha 欠落は終了コード 1" assert_code 1
check "job head_sha 欠落は release.sh を呼ばない" assert_no_release
check "job head_sha 欠落をログに出す" assert_out_contains "head_sha が一致しません"

printf '\n== 31. JSON 不正なら照会不能として配備しない ==\n'
setup_case gate_json
printf 'not-json\n' >"$CASE/gh/runs.json"
run_case ok
check "JSON 不正は終了コード 1" assert_code 1
check "JSON 不正は release.sh を呼ばない" assert_no_release

printf '\n== 32. 新しいrunのSHA欠落を古いsuccessで補わない ==\n'
setup_case gate_incomplete_newrun
cat >"$CASE/gh/runs.json" <<EOF
{"total_count":2,"workflow_runs":[
 {"id":1002,"run_attempt":1,"event":"push","head_branch":"main","path":".github/workflows/ci.yml","created_at":"2026-11-04T01:00:00Z","status":"in_progress","conclusion":null},
 {"id":1001,"run_attempt":1,"head_sha":"$NEW","event":"push","head_branch":"main","path":".github/workflows/ci.yml","created_at":"2026-11-04T00:00:00Z","status":"completed","conclusion":"success"}]}
EOF
run_case ok
check "新runのSHA欠落は終了コード 1" assert_code 1
check "新runのSHA欠落は release.sh を呼ばない" assert_no_release

printf '\n== 33. runs一覧の未取得ページは配備しない ==\n'
setup_case gate_runs_page
node -e 'const fs=require("node:fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p));j.total_count=101;fs.writeFileSync(p,JSON.stringify(j));' "$CASE/gh/runs.json"
run_case ok
check "runs一覧不完全は終了コード 1" assert_code 1
check "runs一覧不完全は release.sh を呼ばない" assert_no_release

printf '\n== 34. jobs一覧の未取得ページは配備しない ==\n'
setup_case gate_jobs_page
node -e 'const fs=require("node:fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p));j.total_count=101;fs.writeFileSync(p,JSON.stringify(j));' "$CASE/gh/jobs-1001-1.json"
run_case ok
check "jobs一覧不完全は終了コード 1" assert_code 1
check "jobs一覧不完全は release.sh を呼ばない" assert_no_release

printf '\n== 35. 呼び出し元の MIRAI_SF_RELEASE_CI_GATE=1 を release.sh へ渡さない（二重照会防止） ==\n'
setup_case gate_env_unset
EXTRA_ENV=(MIRAI_SF_RELEASE_CI_GATE=1)
run_case ok
EXTRA_ENV=()
check "配備成功で終了コード 0" assert_code 0
check "origin/main の commit で release.sh を呼ぶ" assert_release_called_with "$NEW"
if grep -qx "unset" "$CASE/release-ci-gate-env" 2>/dev/null; then
  pass "release.sh には MIRAI_SF_RELEASE_CI_GATE を渡さない"
else
  fail "release.sh には MIRAI_SF_RELEASE_CI_GATE を渡さない（実際: $(cat "$CASE/release-ci-gate-env" 2>/dev/null)）"
fi

printf '\n== 結果: PASS %d / FAIL %d ==\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]]
