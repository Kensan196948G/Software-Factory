#!/usr/bin/env bash
# rto-drill.sh（全体 RTO 訓練）の単体テスト。
# 実 DB・実 R2・本番サービスには触らない。一時ディレクトリに
#   - 偽の本番ホーム（current → releases/<sha>。dist/api/server.js は偽 /healthz サーバー）
#   - 偽の prod.conf（作り物の DATABASE_URL と秘密マーカー）
#   - 偽の pg クライアント（createdb / pg_restore / dropdb / psql。呼び出しを記録するだけ）
#   - 偽の wrangler（fixture をコピー）
# を作り、DB名ガード・dry-run・実行モード（段階・JSON・後片付け）を検証する。
#
# 実行: bash scripts/ops/tests/rto-drill.test.sh
# 終了コード: 0=全件成功 / 1=失敗あり
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TEST_DIR/../../.." && pwd)"
SCRIPT="$ROOT/scripts/ops/rto-drill.sh"
TMP="$(mktemp -d)"
PASS=0
FAIL=0
MARKER="SYNTHETIC_PROD_SECRET_DO_NOT_LEAK"
SHA="abcdefabcdefabcdefabcdefabcdefabcdefabcd"
SRC_DB="mirai_sf_prod_fake"
NODE_DIR="$(dirname "$(command -v node)")"

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
  printf '  終了コード: 期待 %s / 実際 %s\n  --- stderr ---\n%s\n  --- stdout ---\n%s\n  ----------\n' "$1" "$CODE" "$ERR" "$OUT" >&2
  return 1
}
assert_err_contains() {
  if [[ "$ERR" == *"$1"* ]]; then return 0; fi
  printf '  stderr に「%s」がありません\n  --- stderr ---\n%s\n  ----------\n' "$1" "$ERR" >&2
  return 1
}
assert_no_leak() {
  if [[ "$OUT$ERR" != *"$MARKER"* && "$OUT$ERR" != *"fakepass"* ]]; then return 0; fi
  printf '  秘密（マーカー）が出力に出ています\n' >&2
  return 1
}
# stdout が JSON で、式が真になること（j に JSON が入る）
assert_json() { # <説明用> <JS の式>
  if printf '%s' "$OUT" | node -e '
    let raw = ""; process.stdin.on("data", (c) => (raw += c)); process.stdin.on("end", () => {
      let j; try { j = JSON.parse(raw); } catch { console.error("  stdout が JSON ではありません"); process.exit(1); }
      const ok = Function("j", "return (" + process.argv[1] + ");")(j);
      if (!ok) { console.error("  JSON が条件を満たしません: " + process.argv[1]); console.error(raw); process.exit(1); }
    });' "$2"; then return 0; fi
  return 1
}
assert_pg_called() { # <コマンド名> <引数に含まれる文字列>
  if grep -E "^$1 " "$CASE/pg-invocations" 2>/dev/null | grep -qF -- "$2"; then return 0; fi
  printf '  %s が「%s」で呼ばれていません\n' "$1" "$2" >&2
  sed 's/^/    /' "$CASE/pg-invocations" >&2 2>/dev/null || true
  return 1
}
assert_pg_not_called() { # <コマンド名>
  if ! grep -qE "^$1 " "$CASE/pg-invocations" 2>/dev/null; then return 0; fi
  printf '  %s が呼ばれました\n' "$1" >&2
  return 1
}
assert_no_report() {
  if [[ ! -d "$HOME_DIR/rto-reports" ]] || [[ -z "$(ls -A "$HOME_DIR/rto-reports")" ]]; then return 0; fi
  printf '  レポートファイルが書かれました\n' >&2
  return 1
}
assert_report_written() {
  local f
  f="$(find "$HOME_DIR/rto-reports" -name 'rto-drill-*.json' 2>/dev/null | head -n 1)"
  if [[ -n "$f" && "$(stat -c %a "$f")" == 600 ]]; then return 0; fi
  printf '  レポートファイル（0600）がありません\n' >&2
  return 1
}
assert_api_stopped() {
  local pid
  pid="$(cat "$CASE/api.pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    printf '  一時 API（pid %s）が残っています\n' "$pid" >&2
    kill "$pid" 2>/dev/null || true
    return 1
  fi
  return 0
}

free_port() {
  node -e '
    const s = require("node:net").createServer();
    s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });
  '
}

setup_case() { # <name>
  CASE="$TMP/$1"
  HOME_DIR="$CASE/home"
  PROD_HOME="$HOME_DIR/prod"
  BACKUP_DIR="$HOME_DIR/backups"
  RELEASE="$PROD_HOME/releases/$SHA"
  mkdir -p "$RELEASE/dist/api" "$RELEASE/node_modules/.bin" "$BACKUP_DIR" "$CASE/pgbin" "$CASE/bin" "$CASE/r2"
  ln -s "releases/$SHA" "$PROD_HOME/current"
  printf 'COMMIT_SHA=%s\n' "$SHA" >"$RELEASE/release.env"
  : >"$CASE/pg-invocations"
  # 作り物の設定（実在しない接続先。パスワード部分も作り物で、出力に出ないことを検証する）。
  # 接続文字列の形をリポジトリへ直書きしない（secret-scan の対象）ため、実行時に組み立てる
  printf 'DATABASE_URL=postgresql://fake:%s@127.0.0.1:1/%s\nSESSION_SECRET=%s\nNODE_ENV=production\nAPP_ENV=production\nPORT=8783\n' \
    "fakepass" "$SRC_DB" "$MARKER" >"$CASE/prod.conf"
  chmod 600 "$CASE/prod.conf"

  # 偽 /healthz サーバー（current の API の代わり）。DATABASE_URL が一時DBを指すことを確かめてから応答する
  cat >"$RELEASE/dist/api/server.js" <<'EOS'
const http = require('node:http');
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_CASE + '/api.pid', String(process.pid));
fs.writeFileSync(process.env.FAKE_CASE + '/api-env', [
  'db=' + new URL(process.env.DATABASE_URL).pathname.slice(1),
  'port=' + process.env.PORT, 'host=' + process.env.HOST, 'mail=' + process.env.MAIL_MODE,
].join('\n') + '\n');
console.log(process.env.SESSION_SECRET); // 起動ログは表示されないこと
const dbIsTemp = /^mirai_sf_rto_[0-9a-z_]+$/.test(new URL(process.env.DATABASE_URL).pathname.slice(1));
const dbOk = dbIsTemp && process.env.FAKE_API_MODE !== 'db-fail';
// 本物の API と同じく APP_ENV（prod.conf では production）を environment として返す
const environment = process.env.FAKE_API_MODE === 'staging-env' ? 'staging' : process.env.APP_ENV;
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: dbOk ? 'ok' : 'degraded', environment, commit: process.env.COMMIT_SHA, db: { ok: dbOk } }));
}).listen(Number(process.env.PORT), process.env.HOST);
process.on('SIGTERM', () => process.exit(0));
EOS
  # shellcheck disable=SC2016 # 偽 tsx のスクリプト本文（ここでは展開しない）
  printf '#!/bin/sh\nexit "${FAKE_VERIFY_CODE:-0}"\n' >"$RELEASE/node_modules/.bin/tsx"
  chmod +x "$RELEASE/node_modules/.bin/tsx"

  # バックアップ（ローカル）と manifest
  LOCAL_DUMP="$BACKUP_DIR/$SRC_DB-20261105T010000Z.dump"
  printf 'fake dump bytes\n' >"$LOCAL_DUMP"
  printf '#audit_tip\tdeadbeef\nrequests\t3\n' >"$BACKUP_DIR/$SRC_DB-20261105T010000Z.manifest.tsv"
  cp "$LOCAL_DUMP" "$CASE/r2/$SRC_DB-20261105T010000Z.dump"
  cp "$BACKUP_DIR/$SRC_DB-20261105T010000Z.manifest.tsv" "$CASE/r2/$SRC_DB-20261105T010000Z.manifest.tsv"
  write_marker

  # 偽 pg クライアント。psql は件数の 2 段階（union 文の生成 → 件数）を模擬する
  for cmd in createdb dropdb pg_restore; do
    cat >"$CASE/pgbin/$cmd" <<EOS
#!/bin/sh
printf '%s %s\n' "$cmd" "\$*" >>"$CASE/pg-invocations"
# dropdb の失敗を模擬する（cleanup 失敗時の exit 2 の検証用）
if [ "$cmd" = dropdb ] && [ "\${FAKE_DROPDB_FAIL:-}" = 1 ]; then exit 1; fi
exit 0
EOS
  done
  cat >"$CASE/pgbin/psql" <<EOS
#!/bin/sh
printf 'psql %s\n' "\$*" >>"$CASE/pg-invocations"
case "\$*" in
  *string_agg*) echo "select 1" ;;
  *) cat "\${FAKE_COUNTS:-$BACKUP_DIR/$SRC_DB-20261105T010000Z.manifest.tsv}" ;;
esac
EOS
  # 偽 wrangler: r2 object get <bucket/key> --remote --file <dest>
  cat >"$CASE/bin/wrangler" <<EOS
#!/bin/sh
printf 'wrangler %s\n' "\$*" >>"$CASE/pg-invocations"
key="\$4"; dest="\$7"
cp "$CASE/r2/\$(basename "\$key")" "\$dest"
EOS
  chmod +x "$CASE"/pgbin/* "$CASE/bin/wrangler"
  TPORT="$(free_port)"
}

write_marker() { # [dump の sha256 を壊す: bad]
  local dsha msha dsize msize
  dsha="$(sha256sum "$LOCAL_DUMP" | cut -d' ' -f1)"
  msha="$(sha256sum "$BACKUP_DIR/$SRC_DB-20261105T010000Z.manifest.tsv" | cut -d' ' -f1)"
  dsize="$(stat -c %s "$LOCAL_DUMP")"
  msize="$(stat -c %s "$BACKUP_DIR/$SRC_DB-20261105T010000Z.manifest.tsv")"
  [[ "${1:-}" != bad ]] || dsha="$(printf '0%.0s' {1..64})"
  printf '{"bucket":"mirai-sf-prod-backups","uploadedAt":"%s","dump":{"key":"mirai_sf_prod/%s","size":%s,"sha256":"%s"},"manifest":{"key":"mirai_sf_prod/%s","size":%s,"sha256":"%s"}}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$LOCAL_DUMP")" "$dsize" "$dsha" \
    "$SRC_DB-20261105T010000Z.manifest.tsv" "$msize" "$msha" >"$LOCAL_DUMP.r2.json"
}

run_drill() { # [args...]
  local err_file="$CASE/stderr"
  OUT="$(
    env -i \
      PATH="$CASE/bin:$NODE_DIR:/usr/local/bin:/usr/bin:/bin" \
      HOME="$HOME_DIR" \
      FAKE_CASE="$CASE" \
      ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
      MIRAI_SF_PROD_HOME="$PROD_HOME" \
      MIRAI_SF_PROD_ENV_FILE="$CASE/prod.conf" \
      MIRAI_SF_PROD_BACKUP_DIR="$BACKUP_DIR" \
      MIRAI_SF_PG_BIN_DIR="$CASE/pgbin" \
      MIRAI_SF_NODE_BIN_DIR="$CASE/no-node" \
      MIRAI_SF_WRANGLER="$CASE/bin/wrangler" \
      MIRAI_SF_RTO_PORT="${RTO_PORT_OVERRIDE:-$TPORT}" \
      MIRAI_SF_RTO_HEALTH_TIMEOUT=5 \
      MIRAI_SF_RTO_REPORT_DIR="$HOME_DIR/rto-reports" \
      bash "$SCRIPT" "$@" 2>"$err_file"
  )"
  CODE=$?
  ERR="$(cat "$err_file")"
}
EXTRA_ENV=()

printf '== 静的検査 ==\n'
for f in "$SCRIPT" "${BASH_SOURCE[0]}"; do
  if bash -n "$f"; then pass "bash -n $(basename "$f")"; else fail "bash -n $(basename "$f")"; fi
done
if command -v shellcheck >/dev/null 2>&1; then
  for f in "$SCRIPT" "${BASH_SOURCE[0]}"; do
    if shellcheck -x "$f"; then pass "shellcheck $(basename "$f")"; else fail "shellcheck $(basename "$f")"; fi
  done
elif [[ "${CI:-}" == true ]]; then
  fail "shellcheck が見つかりません（CI=true では必須）"
else
  printf 'SKIP: shellcheck が無いため bash -n のみ（ローカルのみ許容。CI=true では FAIL）\n'
fi

printf '\n== G. 一時DB名ガード（DROP 前の検査） ==\n'
# shellcheck source=scripts/ops/rto-drill.sh
source "$SCRIPT"
# rto-drill.sh の set -e / umask はテストのシェルへ持ち込まない（失敗経路の検証で止まらないように）
set +e
umask 022
guard_ok() { if rto_db_name_ok "$1" "$SRC_DB"; then pass "受理: $1"; else fail "受理されるべき: $1"; fi; }
guard_ng() { if rto_db_name_ok "$1" "${2:-$SRC_DB}"; then fail "拒否されるべき: $1"; else pass "拒否: ${3:-$1}"; fi; }
guard_ok "mirai_sf_rto_20261105t080000z_12345"
guard_ng "$SRC_DB"
guard_ng "mirai_sf_prod"
guard_ng "postgres"
guard_ng "mirai_sf_rto_"
guard_ng "xmirai_sf_rto_1"
guard_ng "mirai_sf_rto_1;drop database mirai_sf_prod" "$SRC_DB" "記号入り"
guard_ng "mirai_sf_rto_ABC"
guard_ng "mirai_sf_rto_1 x" "$SRC_DB" "空白入り"
guard_ng $'mirai_sf_rto_1\nmirai_sf_prod' "$SRC_DB" "改行入り"
guard_ng "mirai_sf_rto_$(printf 'a%.0s' {1..60})" "$SRC_DB" "63 文字超"
guard_ng "mirai_sf_rto_same" "mirai_sf_rto_same" "復元元と同名"

printf '\n== R1. --dry-run（R2）は前提確認と計画だけ ==\n'
setup_case dry_r2
run_drill --dry-run
check "dry-run は終了コード 0" assert_code 0
check "stdout は JSON（mode=dry-run, result=ok）" assert_json x 'j.mode === "dry-run" && j.result === "ok" && j.source === "r2"'
check "段階は detect と decide だけ" assert_json x 'j.stages.map((s) => s.name).join(",") === "detect,decide" && j.stages.every((s) => s.ok)'
check "各段階に開始・終了時刻がある" assert_json x 'j.stages.every((s) => /Z$/.test(s.startedAt) && /Z$/.test(s.endedAt) && s.seconds >= 0)'
check "一時DB名は mirai_sf_rto_ で始まる" assert_json x '/^mirai_sf_rto_[0-9a-z_]+$/.test(j.tempDb)'
check "current の commit を記録" assert_json x "j.release.commit === '$SHA'"
check "dry-run は DB を作らない" assert_pg_not_called createdb
check "dry-run は DB を消さない" assert_pg_not_called dropdb
check "dry-run は R2 から取得しない" assert_pg_not_called wrangler
check "dry-run はレポートファイルを書かない" assert_no_report
check "dry-run は計画を表示する" assert_err_contains "[dry-run] 計画"
check "prod.conf の値（秘密）を出さない" assert_no_leak

printf '\n== R2. --dry-run --local ==\n'
setup_case dry_local
run_drill --dry-run --local
check "local の dry-run は終了コード 0" assert_code 0
check "source=local" assert_json x 'j.source === "local" && j.backup.file === "mirai_sf_prod_fake-20261105T010000Z.dump"'

printf '\n== R3. 本番・Staging のポートは使わない ==\n'
setup_case dry_port
RTO_PORT_OVERRIDE=8783 run_drill --dry-run
check "8783 は終了コード 1" assert_code 1
check "ポート拒否をログに出す" assert_err_contains "一時ポートに開発・Staging・本番のポート"
check "decide 段階は失敗として記録" assert_json x 'j.result === "failed" && j.stages.some((s) => s.name === "decide" && !s.ok)'

printf '\n== R4. 使用中のポートは使わない ==\n'
setup_case dry_busy
node -e 'require("node:net").createServer().listen(Number(process.argv[1]), "127.0.0.1"); setTimeout(() => {}, 15000);' "$TPORT" &
BUSY_PID=$!
for _ in $(seq 1 50); do (exec 3<>"/dev/tcp/127.0.0.1/$TPORT") 2>/dev/null && break; sleep 0.1; done
run_drill --dry-run
kill "$BUSY_PID" 2>/dev/null || true
wait "$BUSY_PID" 2>/dev/null || true
check "使用中ポートは終了コード 1" assert_code 1
check "使用中をログに出す" assert_err_contains "使用中です"

printf '\n== R5. current が無ければ前提 NG ==\n'
setup_case dry_nocurrent
rm -f "$PROD_HOME/current"
run_drill --dry-run
check "current 無しは終了コード 1" assert_code 1
check "current 無しをログに出す" assert_err_contains "current リリースがありません"

printf '\n== R6. R2 送信記録が無ければ前提 NG（--local を案内） ==\n'
setup_case dry_nomarker
rm -f "$LOCAL_DUMP.r2.json"
run_drill --dry-run
check "送信記録無しは終了コード 1" assert_code 1
check "--local を案内する" assert_err_contains "--local"

printf '\n== R7. 不明な引数 ==\n'
setup_case usage
run_drill --bogus
check "不明な引数は終了コード 1" assert_code 1
check "不明な引数をログに出す" assert_err_contains "不明な引数"

printf '\n== X1. 実行モード（R2）: 取得→復元→検証→API→切替判断→後片付け ==\n'
setup_case run_r2
run_drill
check "成功は終了コード 0" assert_code 0
check "全段階が順に成功" assert_json x 'j.stages.map((s) => s.name).join(",") === "detect,decide,fetch,restore,verify,api,switch_decision,cleanup" && j.stages.every((s) => s.ok)'
check "result=ok・切替判断を記録・目標内" assert_json x 'j.mode === "run" && j.result === "ok" && /切替可能/.test(j.decision) && j.withinTarget === true && j.totalSeconds >= 0'
check "R2 から dump と manifest を取得" assert_pg_called wrangler "r2 object get mirai-sf-prod-backups/mirai_sf_prod/$SRC_DB-20261105T010000Z.dump"
check "一時DBを作成（maintenance-db=postgres）" assert_pg_called createdb "--maintenance-db=postgres --template=template0 --encoding=UTF8 mirai_sf_rto_"
check "一時DBへ pg_restore" assert_pg_called pg_restore "-d mirai_sf_rto_"
check "一時DBを削除" assert_pg_called dropdb "--maintenance-db=postgres --if-exists --force mirai_sf_rto_"
# 接続先・作成/削除の対象（-d の値と createdb/dropdb の最後の引数）に本番DB名が無いこと（dump のファイル名は除く）
if grep -E '^(createdb|dropdb) ' "$CASE/pg-invocations" | awk '{ print $NF }' | grep -qvE '^mirai_sf_rto_[0-9a-z_]+$' ||
  grep -E '^(pg_restore|psql) ' "$CASE/pg-invocations" | grep -oE -- '-d [^ ]+' | grep -qvE -- '^-d mirai_sf_rto_[0-9a-z_]+$'; then
  fail "一時DB以外を対象に createdb/dropdb/pg_restore/psql が呼ばれた"
else
  pass "createdb/dropdb/pg_restore/psql の対象は一時DBだけ（本番DBへ接続しない）"
fi
if grep -qE '^db=mirai_sf_rto_[0-9a-z_]+$' "$CASE/api-env" && grep -qx "port=$TPORT" "$CASE/api-env" &&
  grep -qx 'host=127.0.0.1' "$CASE/api-env" && grep -qx 'mail=off' "$CASE/api-env"; then
  pass "一時 API は一時DB・一時ポート・127.0.0.1・MAIL_MODE=off で起動（prod.conf の PORT を上書き）"
else
  fail "一時 API の環境が不正: $(tr '\n' ' ' <"$CASE/api-env" 2>/dev/null)"
fi
check "一時 API は停止済み" assert_api_stopped
check "レポートを 0600 で保存" assert_report_written
check "prod.conf の値・API の起動ログを出さない" assert_no_leak

printf '\n== X2. 実行モード（--local） ==\n'
setup_case run_local
run_drill --local
check "local の実行は終了コード 0" assert_code 0
check "local では R2 から取得しない" assert_pg_not_called wrangler
check "local でも全段階が成功" assert_json x 'j.result === "ok" && j.stages.length === 8'

printf '\n== X3. /healthz の db.ok=false は失敗し、一時DBは削除する ==\n'
setup_case run_dbfail
EXTRA_ENV=(FAKE_API_MODE=db-fail)
run_drill --local
EXTRA_ENV=()
check "db.ok=false は終了コード 1" assert_code 1
check "api 段階が失敗として記録" assert_json x 'j.result === "failed" && j.stages.some((s) => s.name === "api" && !s.ok) && j.stages.some((s) => s.name === "cleanup" && s.ok)'
check "失敗しても一時DBを削除" assert_pg_called dropdb "mirai_sf_rto_"
check "失敗しても一時 API は停止済み" assert_api_stopped

printf '\n== X4. manifest 不一致は失敗し、一時DBは削除する ==\n'
setup_case run_mismatch
printf '#audit_tip\tdeadbeef\nrequests\t999\n' >"$CASE/wrong-counts.tsv"
EXTRA_ENV=(FAKE_COUNTS="$CASE/wrong-counts.tsv")
run_drill --local
EXTRA_ENV=()
check "manifest 不一致は終了コード 1" assert_code 1
check "verify 段階が失敗" assert_json x 'j.stages.some((s) => s.name === "verify" && !s.ok)'
check "API は起動しない" assert_json x '!j.stages.some((s) => s.name === "api")'
check "不一致でも一時DBを削除" assert_pg_called dropdb "mirai_sf_rto_"

printf '\n== X5. db.ts verify の失敗は失敗し、一時DBは削除する ==\n'
setup_case run_verify
EXTRA_ENV=(FAKE_VERIFY_CODE=1)
run_drill --local
EXTRA_ENV=()
check "verify 失敗は終了コード 1" assert_code 1
check "verify 失敗をログに出す" assert_err_contains "db:verify"
check "verify 失敗でも一時DBを削除" assert_pg_called dropdb "mirai_sf_rto_"

printf '\n== X6. R2 の SHA-256 不一致は復元しない ==\n'
setup_case run_badsha
write_marker bad
run_drill
check "SHA-256 不一致は終了コード 1" assert_code 1
check "fetch 段階が失敗" assert_json x 'j.stages.some((s) => s.name === "fetch" && !s.ok)'
check "SHA-256 不一致では DB を作らない" assert_pg_not_called createdb
check "SHA-256 不一致では DB を消さない（作っていない）" assert_pg_not_called dropdb

printf '\n== X7. 環境に死んだプロキシがあっても一時 API の /healthz は直接確認する（--noproxy） ==\n'
setup_case run_proxy
# 何も待ち受けていないポートをプロキシに設定する（env -i で隠さず、明示的に渡す）
DEAD_PROXY="http://127.0.0.1:$(free_port)"
EXTRA_ENV=(HTTP_PROXY="$DEAD_PROXY" http_proxy="$DEAD_PROXY" HTTPS_PROXY="$DEAD_PROXY" https_proxy="$DEAD_PROXY" ALL_PROXY="$DEAD_PROXY" all_proxy="$DEAD_PROXY")
run_drill --local
EXTRA_ENV=()
check "死んだプロキシがあっても成功（終了コード 0）" assert_code 0
check "api 段階が成功" assert_json x 'j.stages.some((s) => s.name === "api" && s.ok)'

printf '\n== X8. /healthz の environment が production でなければ失敗する ==\n'
setup_case run_wrongenv
EXTRA_ENV=(FAKE_API_MODE=staging-env)
run_drill --local
EXTRA_ENV=()
check "environment 不一致は終了コード 1" assert_code 1
check "api 段階が失敗" assert_json x 'j.result === "failed" && j.stages.some((s) => s.name === "api" && !s.ok)'
check "診断に environment=production の条件を出す" assert_err_contains "commit 一致・environment=production になりません"
check "environment 不一致でも一時DBを削除" assert_pg_called dropdb "mirai_sf_rto_"
check "environment 不一致でも一時 API は停止済み" assert_api_stopped

printf '\n== X9. レポートを保存できなければ reportSaved=false（終了コードは変えない） ==\n'
setup_case run_report_fail
mkdir -p "$HOME_DIR"
: >"$HOME_DIR/rto-reports" # ディレクトリの位置にファイルを置く
run_drill --local
check "レポート保存失敗でも訓練成功は終了コード 0" assert_code 0
check "JSON に reportSaved=false" assert_json x 'j.result === "ok" && j.reportSaved === false'
check "保存失敗を注意として出す" assert_err_contains "reportSaved=false"

printf '\n== X10. レポートを保存できれば reportSaved=true、dry-run は null ==\n'
setup_case run_report_ok
run_drill --local
check "保存できれば reportSaved=true" assert_json x 'j.reportSaved === true && j.tempDbRemaining === false'
setup_case dry_report
run_drill --dry-run --local
check "dry-run は reportSaved=null" assert_json x 'j.reportSaved === null'

printf '\n== X11. 一時DBを削除できなければ終了コード 2 と残存DB名を報告する ==\n'
setup_case run_dropfail
EXTRA_ENV=(FAKE_DROPDB_FAIL=1)
run_drill --local
EXTRA_ENV=()
check "dropdb 失敗は終了コード 2" assert_code 2
check "cleanup 段階が失敗・残存フラグ・result=failed" assert_json x 'j.result === "failed" && j.tempDbRemaining === true && j.stages.some((s) => s.name === "cleanup" && !s.ok && s.note.includes(j.tempDb))'
check "残存DB名は mirai_sf_rto_ で始まる" assert_json x '/^mirai_sf_rto_[0-9a-z_]+$/.test(j.tempDb)'
check "残存DB名と手動 dropdb をログに出す" assert_err_contains "一時DBを削除できませんでした（手動で dropdb）: mirai_sf_rto_"
check "dropdb 失敗でも一時 API は停止済み" assert_api_stopped

printf '\n== 結果: PASS %d / FAIL %d ==\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]]
