#!/usr/bin/env bash
# scripts/ops/pr-ready.mjs（PR マージ前ゲート）の隔離テスト。
# 実サービス・実 DB・実 GitHub には触らない。一時ディレクトリに
#   - 偽 gh（PATH は $CASE/bin のみ。GraphQL / protection / check-runs を fixture から返す）
#   - fixture（pr.json / protection.json / checks.json）
# を作り、0 / 75 / 1 の各経路と --checks・--json・秘密非出力・読み取り専用を検証する。
#
# 実行: bash scripts/ops/tests/pr-ready.test.sh
# 終了コード: 0=全件成功 / 1=失敗あり
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TEST_DIR/../../.." && pwd)"
SCRIPT="$ROOT/scripts/ops/pr-ready.mjs"
NODE_BIN="$(command -v node)"
TMP="$(mktemp -d)"
PASS=0
FAIL=0
CASE=""
OUT=""
CODE=0

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
  printf '  終了コード: 期待 %s / 実際 %s\n  --- 出力 ---\n%s\n  ----------\n' "$1" "$CODE" "$OUT" >&2
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
assert_out_matches() {
  if grep -Eq -- "$1" <<<"$OUT"; then return 0; fi
  printf '  出力が正規表現「%s」に一致しません\n  --- 出力 ---\n%s\n  ----------\n' "$1" "$OUT" >&2
  return 1
}
assert_json() { # <js expression using d>
  local expr="$1" last
  last="$(printf '%s\n' "$OUT" | tail -n 1)"
  if printf '%s' "$last" | "$NODE_BIN" -e '
let s = "";
process.stdin.on("data", (chunk) => { s += chunk; });
process.stdin.on("end", () => {
  let d;
  try { d = JSON.parse(s); } catch { process.exit(2); }
  process.exit(eval(process.argv[1]) ? 0 : 1);
});' "$expr" 2>/dev/null; then return 0; fi
  printf '  JSON 判定に失敗: %s\n  --- 出力 ---\n%s\n' "$expr" "$OUT" >&2
  return 1
}
# 書き込み系の端点を呼んでいないこと（GET と読み取り専用 GraphQL 以外は使わない）
assert_no_mutation() {
  if grep -Eq -- '--method (POST|PUT|PATCH|DELETE)' "$CASE/gh-invocations" 2>/dev/null; then
    printf '  書き込み系の gh 呼び出しがあります:\n%s\n' "$(cat "$CASE/gh-invocations")" >&2
    return 1
  fi
  if grep -q 'mutation' "$CASE/gh-invocations" 2>/dev/null; then
    printf '  GraphQL mutation を呼んでいます\n' >&2
    return 1
  fi
  return 0
}
assert_no_dispatch() {
  if ! grep -q 'workflow run' "$CASE/gh-invocations" 2>/dev/null; then return 0; fi
  printf '  workflow run（再実行）を呼んでいます:\n%s\n' "$(cat "$CASE/gh-invocations")" >&2
  return 1
}

HEAD_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
APP_ID=15368

setup_case() { # <name>
  CASE="$TMP/$1"
  GH_DIR="$CASE/gh"
  mkdir -p "$CASE/bin" "$CASE/home" "$GH_DIR"
  : >"$CASE/gh-invocations"
  write_fake_gh
  write_protection false true
  write_pr
  write_checks "quality:completed:success" "e2e:completed:success" "docker:completed:success"
}

write_fake_gh() {
  cat >"$CASE/bin/gh" <<'EOS'
#!/bin/bash
set -uo pipefail
printf '%s\n' "$*" >>"$CASE/gh-invocations"
if [[ "${FAKE_GH_MODE:-ok}" == leak ]]; then
  echo "gh: HTTP 401 token=ghp_SYNTHETIC_MARKER_DO_NOT_LEAK https://example.invalid/x?token=marker" >&2
  exit 1
fi
if [[ "${1:-}" == "api" && "${2:-}" == "graphql" ]]; then
  file="$FAKE_GH_DIR/pr.json"
elif [[ "${1:-}" == "api" && "${2:-}" == "--method" && "${3:-}" == "GET" ]]; then
  path="${4:-}"
  if [[ "$path" == *"/branches/"*"/protection" ]]; then
    if [[ "${FAKE_GH_PROTECTION_MODE:-ok}" == error ]]; then
      echo "gh: HTTP 403 Forbidden (SYNTHETIC_MARKER_DO_NOT_LEAK)" >&2
      exit 1
    fi
    file="$FAKE_GH_DIR/protection.json"
  elif [[ "$path" == *"/check-runs"* ]]; then
    file="$FAKE_GH_DIR/checks.json"
  else
    echo "fake gh: 想定外のパス: $path" >&2
    exit 1
  fi
else
  echo "fake gh: 想定外の引数: $*" >&2
  exit 1
fi
if [[ ! -f "$file" ]]; then
  echo "fake gh: fixture がありません: $file" >&2
  exit 1
fi
# PATH を $CASE/bin だけに絞るため、外部コマンド（cat）を使わずに全行を出す
while IFS= read -r line || [[ -n "$line" ]]; do
  printf '%s\n' "$line"
done <"$file"
EOS
  chmod +x "$CASE/bin/gh"
}

# write_pr [mergeStateStatus] [mergeable] [isDraft] [state] [base] [headBranch] [crossRepo] [reviewDecision] [unresolved] [rollupSkip] [rollupFail]
write_pr() {
  local merge_state="${1:-CLEAN}" mergeable="${2:-MERGEABLE}" draft="${3:-false}" state="${4:-OPEN}"
  local base="${5:-main}" head_branch="${6:-auto/test}" cross="${7:-false}" review="${8:-null}"
  local unresolved="${9:-0}" rollup_skip="${10:-}" rollup_fail="${11:-}"
  local nodes="" sep="" name conclusion threads="" thread_sep="" i
  local count=0
  for name in quality e2e docker; do
    [[ ",$rollup_skip," == *",$name,"* ]] && continue
    conclusion="SUCCESS"
    [[ ",$rollup_fail," == *",$name,"* ]] && conclusion="FAILURE"
    nodes+="$sep{\"__typename\":\"CheckRun\",\"name\":\"$name\",\"status\":\"COMPLETED\",\"conclusion\":\"$conclusion\",\"checkSuite\":{\"app\":{\"databaseId\":$APP_ID}}}"
    sep=","
    count=$((count + 1))
  done
  for ((i = 0; i < unresolved; i += 1)); do
    threads+="$thread_sep{\"isResolved\":false}"
    thread_sep=","
  done
  local review_json="null"
  [[ "$review" != "null" ]] && review_json="\"$review\""
  printf '{"data":{"repository":{"pullRequest":{"number":101,"isDraft":%s,"state":"%s","mergeable":"%s","mergeStateStatus":"%s","baseRefName":"%s","headRefName":"%s","headRefOid":"%s","isCrossRepository":%s,"reviewDecision":%s,"reviewThreads":{"totalCount":%d,"pageInfo":{"hasNextPage":false},"nodes":[%s]},"statusCheckRollup":{"contexts":{"totalCount":%d,"pageInfo":{"hasNextPage":false},"nodes":[%s]}}}}}}\n' \
    "$draft" "$state" "$mergeable" "$merge_state" "$base" "$head_branch" "$HEAD_SHA" "$cross" \
    "$review_json" "$unresolved" "$threads" "$count" "$nodes" >"$GH_DIR/pr.json"
}

write_pr_no_rollup() {
  printf '{"data":{"repository":{"pullRequest":{"number":101,"isDraft":false,"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","baseRefName":"main","headRefName":"auto/test","headRefOid":"%s","isCrossRepository":false,"reviewDecision":null,"reviewThreads":{"totalCount":0,"pageInfo":{"hasNextPage":false},"nodes":[]},"statusCheckRollup":null}}}}\n' \
    "$HEAD_SHA" >"$GH_DIR/pr.json"
}

# write_protection <strict true|false> <conversation true|false> [checks csv]
write_protection() {
  local strict="${1:-false}" conversation="${2:-true}" check_csv="${3:-quality,e2e,docker}"
  local checks_json="" contexts_json="" sep="" name
  for name in ${check_csv//,/ }; do
    checks_json+="$sep{\"context\":\"$name\",\"app_id\":$APP_ID}"
    contexts_json+="${contexts_json:+,}\"$name\""
    sep=","
  done
  printf '{"required_status_checks":{"strict":%s,"contexts":[%s],"checks":[%s]},"required_conversation_resolution":{"enabled":%s}}\n' \
    "$strict" "$contexts_json" "$checks_json" "$conversation" >"$GH_DIR/protection.json"
}

# write_checks <name:status:conclusion[:appId]> ...
# conclusion は null 可。id は記載順に増える（最後のものが最大 id）。
write_checks() {
  local runs="" sep="" spec name rest status conclusion app_id run_id=1000
  local count=0
  for spec in "$@"; do
    name="${spec%%:*}"
    rest="${spec#*:}"
    status="${rest%%:*}"
    rest="${rest#*:}"
    conclusion="${rest%%:*}"
    app_id="$APP_ID"
    if [[ "$rest" == *:* ]]; then app_id="${rest#*:}"; fi
    local conclusion_json="null"
    [[ "$conclusion" != "null" ]] && conclusion_json="\"$conclusion\""
    runs+="$sep{\"id\":$run_id,\"name\":\"$name\",\"head_sha\":\"$HEAD_SHA\",\"status\":\"$status\",\"conclusion\":$conclusion_json,\"app\":{\"id\":$app_id}}"
    sep=","
    run_id=$((run_id + 1))
    count=$((count + 1))
  done
  printf '{"total_count":%d,"check_runs":[%s]}\n' "$count" "$runs" >"$GH_DIR/checks.json"
}

run_case() {
  local -a extra_env=()
  if [[ "${PROTECTION_ERROR:-0}" == "1" ]]; then extra_env+=("FAKE_GH_PROTECTION_MODE=error"); fi
  if [[ "${GH_LEAK:-0}" == "1" ]]; then extra_env+=("FAKE_GH_MODE=leak"); fi
  OUT="$(env -i PATH="$CASE/bin" HOME="$CASE/home" CASE="$CASE" FAKE_GH_DIR="$GH_DIR" \
    ${extra_env[@]+"${extra_env[@]}"} \
    "$NODE_BIN" "$SCRIPT" "$@" 2>&1)"
  CODE=$?
  PROTECTION_ERROR=0
  GH_LEAK=0
}

printf '== 静的な検査 ==\n'
if node --check "$SCRIPT" >/dev/null 2>&1; then pass "node --check pr-ready.mjs"; else fail "node --check pr-ready.mjs"; fi

printf '\n== P1. 必須チェックがすべて success なら 0 ==\n'
setup_case ok
run_case 101
check "正常時は終了コード 0" assert_code 0
check "OK を 1 行で出す" assert_out_contains "[pr-ready] OK pr=101"
check "3 チェックの結果を出す" assert_out_contains "checks=quality:success,e2e:success,docker:success"
check "書き込み系の gh 呼び出しが無い" assert_no_mutation

printf '\n== P2. チェックが 1 つも無ければ 75（PR-linked な run が必要） ==\n'
setup_case no_checks
write_checks
run_case 101
check "チェック無しは終了コード 75" assert_code 75
check "未確認を出す" assert_out_contains "[pr-ready] 未確認:"
check "必須チェックがまだありませんと出す" assert_out_contains "必須チェックがまだありません（quality, e2e, docker）"
check "PR-linked な run が必要と案内する" assert_out_contains "PR-linked な run が必要です"
check "workflow_dispatch では満たせないと案内する" assert_out_contains "workflow_dispatch では required status を満たせません"
check "再実行（dispatch）はしない" assert_no_dispatch

printf '\n== P3. 実行中のチェックがあれば 75 ==\n'
setup_case in_progress
write_checks "quality:in_progress:null" "e2e:completed:success" "docker:completed:success"
run_case 101
check "実行中は終了コード 75" assert_code 75
check "未完了のチェック名を出す" assert_out_contains "必須チェックが未完了です（quality: in_progress）"

printf '\n== P4. cancelled は 75（後続に置換された可能性） ==\n'
setup_case cancelled
write_checks "quality:completed:success" "e2e:completed:cancelled" "docker:completed:success"
run_case 101
check "cancelled は終了コード 75" assert_code 75
check "cancelled を出す" assert_out_contains "e2e: cancelled"

printf '\n== P5. stale は 75（後続に置換された可能性） ==\n'
setup_case stale
write_checks "quality:completed:success" "e2e:completed:stale" "docker:completed:success"
run_case 101
check "stale は終了コード 75" assert_code 75
check "stale を出す" assert_out_contains "e2e: stale"

printf '\n== P6. failure は 1 ==\n'
setup_case failure
write_checks "quality:completed:success" "e2e:completed:failure" "docker:completed:success"
run_case 101
check "failure は終了コード 1" assert_code 1
check "失敗の詳細を出す" assert_out_contains "必須チェックが失敗しました（e2e: failure）"

printf '\n== P7. skipped は 1（黙って停滞させない） ==\n'
setup_case skipped
write_checks "quality:completed:success" "e2e:completed:skipped" "docker:completed:success"
run_case 101
check "skipped は終了コード 1" assert_code 1
check "skipped を失敗として出す" assert_out_contains "e2e: skipped"

printf '\n== P8. draft は 1 ==\n'
setup_case draft
write_pr CLEAN MERGEABLE true
run_case 101
check "draft は終了コード 1" assert_code 1
check "draft の理由を出す" assert_out_contains "PR が draft です"

printf '\n== P9. closed（state != OPEN）は 1 ==\n'
setup_case closed
write_pr CLEAN MERGEABLE false CLOSED
run_case 101
check "closed は終了コード 1" assert_code 1
check "state を出す" assert_out_contains "state=CLOSED"

printf '\n== P10. 競合（mergeable=CONFLICTING）は 1 ==\n'
setup_case conflicting
write_pr CLEAN CONFLICTING
run_case 101
check "競合は終了コード 1" assert_code 1
check "競合の理由を出す" assert_out_contains "mergeable=CONFLICTING"

printf '\n== P11. base 不一致は 1 ==\n'
setup_case base_mismatch
write_pr CLEAN MERGEABLE false OPEN release
run_case 101
check "base 不一致は終了コード 1" assert_code 1
check "base の期待値を出す" assert_out_contains "base が想定と違います"

printf '\n== P12. head が base と同じブランチなら 1 ==\n'
setup_case head_is_base
write_pr CLEAN MERGEABLE false OPEN main main
run_case 101
check "head==base は終了コード 1" assert_code 1
check "理由を出す" assert_out_contains "head が base と同じブランチです"

printf '\n== P13. 保護設定を読めない場合は 1（--checks の案内） ==\n'
setup_case protection_error
PROTECTION_ERROR=1
run_case 101
check "保護設定不読は終了コード 1" assert_code 1
check "--checks を案内する" assert_out_contains "--checks で必須チェック名を指定してください"
check "マーカーを出さない" assert_out_not_contains "SYNTHETIC_MARKER_DO_NOT_LEAK"

printf '\n== P13b. --checks 指定なら保護設定を読まずに判定する ==\n'
PROTECTION_ERROR=1
run_case 101 --checks quality,e2e,docker
check "--checks 指定時は終了コード 0" assert_code 0
check "警告を出す" assert_out_contains "保護設定を読みません"
check "保護設定を照会しない" assert_no_mutation

printf '\n== P14. head の check run は success でも PR の rollup に無ければ 75 ==\n'
setup_case rollup_missing
write_pr CLEAN MERGEABLE false OPEN main auto/test false null 0 e2e
run_case 101
check "rollup 欠落は終了コード 75" assert_code 75
check "rollup に揃っていないと出す" assert_out_contains "statusCheckRollup に required が揃っていません（e2e）"
check "PR-linked な run が必要と案内する" assert_out_contains "PR-linked な run が必要です"

printf '\n== P15. rollup が null なら 75（PR-linked でない） ==\n'
setup_case rollup_null
write_pr_no_rollup
run_case 101
check "rollup なしは終了コード 75" assert_code 75
check "PR-linked な run が必要と案内する" assert_out_contains "PR-linked な run が必要です"

printf '\n== P16. 未解決スレッド（保護が要求）は 1 ==\n'
setup_case unresolved
write_pr CLEAN MERGEABLE false OPEN main auto/test false null 2
run_case 101
check "未解決スレッドは終了コード 1" assert_code 1
check "件数を出す" assert_out_contains "未解決のレビュースレッドがあります（2 件）"

printf '\n== P17. 未解決スレッドでも保護が要求していなければ 0 ==\n'
setup_case unresolved_not_required
write_protection false false
write_pr CLEAN MERGEABLE false OPEN main auto/test false null 2
run_case 101
check "会話解決が不要なら終了コード 0" assert_code 0

printf '\n== P18. 同一名の check は id 最大（新しい方）を採用する（成功） ==\n'
setup_case latest_success
write_checks "quality:in_progress:null" "quality:completed:success" "e2e:completed:success" "docker:completed:success"
run_case 101
check "新しい success を採用して 0" assert_code 0

printf '\n== P19. 同一名の check は id 最大（新しい方）を採用する（失敗） ==\n'
setup_case latest_failure
write_checks "quality:completed:success" "quality:completed:failure" "e2e:completed:success" "docker:completed:success"
run_case 101
check "新しい failure を採用して 1" assert_code 1
check "失敗の詳細を出す" assert_out_contains "quality: failure"

printf '\n== P20. 別アプリの同名チェックは成功扱いしない ==\n'
setup_case app_mismatch
write_checks "quality:completed:success:999" "e2e:completed:success" "docker:completed:success"
run_case 101
check "app_id 不一致は 75" assert_code 75
check "quality を未実行として扱う" assert_out_contains "必須チェックがまだありません（quality）"

printf '\n== P21. mergeStateStatus=UNKNOWN は 75 ==\n'
setup_case merge_unknown
write_pr UNKNOWN
run_case 101
check "mergeStateStatus UNKNOWN は終了コード 75" assert_code 75
check "再実行を案内する" assert_out_contains "mergeStateStatus=UNKNOWN"

printf '\n== P22. BEHIND は strict=false なら許容（0） ==\n'
setup_case behind_ok
write_pr BEHIND
run_case 101
check "strict=false の BEHIND は終了コード 0" assert_code 0
check "警告を出す" assert_out_contains "mergeStateStatus=BEHIND"

printf '\n== P23. BEHIND は strict=true なら 1 ==\n'
setup_case behind_strict
write_protection true true
write_pr BEHIND
run_case 101
check "strict=true の BEHIND は終了コード 1" assert_code 1
check "base 更新が必要と出す" assert_out_contains "strict=true"

printf '\n== P24. BLOCKED 単独では失敗にしない（必須が揃うまで 75） ==\n'
setup_case blocked
write_pr BLOCKED
run_case 101
check "BLOCKED は終了コード 75" assert_code 75
check "保護の別条件を案内する" assert_out_contains "mergeStateStatus=BLOCKED"

printf '\n== P25. reviewDecision が CHANGES_REQUESTED / REVIEW_REQUIRED なら 1 ==\n'
setup_case changes_requested
write_pr CLEAN MERGEABLE false OPEN main auto/test false CHANGES_REQUESTED
run_case 101
check "CHANGES_REQUESTED は終了コード 1" assert_code 1
check "理由を出す" assert_out_contains "CHANGES_REQUESTED"
setup_case review_required
write_pr CLEAN MERGEABLE false OPEN main auto/test false REVIEW_REQUIRED
run_case 101
check "REVIEW_REQUIRED は終了コード 1" assert_code 1
check "理由を出す" assert_out_contains "REVIEW_REQUIRED"

printf '\n== P26. --json は 1 行の JSON を出す ==\n'
setup_case json_output
run_case 101 --json
check "--json でも終了コード 0" assert_code 0
check "code=0" assert_json 'd.code === 0 && d.ok === true'
check "requiredChecks が 3 件" assert_json 'Array.isArray(d.requiredChecks) && d.requiredChecks.length === 3'
check "checks が 3 件" assert_json 'Array.isArray(d.checks) && d.checks.length === 3'
check "reasons が配列" assert_json 'Array.isArray(d.reasons)'

printf '\n== P27. 引数不正は 1（使い方を出す） ==\n'
setup_case args
run_case
check "引数なしは終了コード 1" assert_code 1
check "使い方を出す" assert_out_contains "使い方:"
run_case abc
check "不正な PR 番号は 1" assert_code 1
run_case 101 --unknown
check "不明なオプションは 1" assert_code 1
run_case 101 --dispatch
check "--dispatch は v1 では未実装として 1" assert_code 1
check "未実装の理由を出す" assert_out_contains "v1 では --dispatch は実装していません"
check "再実行（dispatch）はしない" assert_no_dispatch

printf '\n== P28. gh エラー時に stderr 本文（秘密になり得る文字列）を出さない ==\n'
setup_case gh_error
GH_LEAK=1
run_case 101
check "gh エラーは終了コード 1" assert_code 1
check "照会エラーを出す" assert_out_contains "照会エラー"
check "マーカーを出さない" assert_out_not_contains "SYNTHETIC_MARKER_DO_NOT_LEAK"
check "トークンらしき文字列を出さない" assert_out_not_contains "ghp_"

printf '\n== P29. 全ケースを通じて書き込み系の gh 呼び出し・dispatch が無い ==\n'
# 最後の CASE ではなく全ケースの記録を横断して確認する
MUTATION_COUNT=0
DISPATCH_COUNT=0
while IFS= read -r case_dir; do
  [[ -f "$case_dir/gh-invocations" ]] || continue
  if grep -Eq -- '--method (POST|PUT|PATCH|DELETE)' "$case_dir/gh-invocations"; then MUTATION_COUNT=$((MUTATION_COUNT + 1)); fi
  if grep -q 'workflow run' "$case_dir/gh-invocations"; then DISPATCH_COUNT=$((DISPATCH_COUNT + 1)); fi
done < <(find "$TMP" -mindepth 1 -maxdepth 1 -type d)
if [[ "$MUTATION_COUNT" -eq 0 ]]; then pass "書き込み系の gh 呼び出しは 0 件"; else fail "書き込み系の gh 呼び出しが $MUTATION_COUNT ケースあります"; fi
if [[ "$DISPATCH_COUNT" -eq 0 ]]; then pass "workflow run（再実行）は 0 件"; else fail "workflow run が $DISPATCH_COUNT ケースあります"; fi

printf '\n== 結果: PASS %d / FAIL %d ==\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
