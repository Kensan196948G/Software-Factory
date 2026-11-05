#!/usr/bin/env bash
# mirai-sf-onfailure@.service（失敗通知）の単体テスト。
# systemd へは配置・起動しない。unit の ExecStart と同じ本文を /bin/sh で実行し、
# 一時 HOME の alerts.jsonl・notify.env・偽通知コマンドで挙動を検証する。
#
# 実行: bash scripts/ops/tests/onfailure-notify.test.sh
# 終了コード: 0=全件成功 / 1=失敗あり
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TEST_DIR/../../.." && pwd)"
UNIT="$ROOT/deploy/systemd/mirai-sf-onfailure@.service"
BODY_SRC="$ROOT/deploy/systemd/mirai-sf-onfailure.body.sh"
GEN="$TEST_DIR/onfailure-execstart.mjs"
TMP="$(mktemp -d)"
PASS=0
FAIL=0
MARKER="SYNTHETIC_NOTIFY_SECRET_DO_NOT_LEAK"

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
alerts_file() { printf '%s/.local/state/mirai-sf/alerts.jsonl' "$HOME_DIR"; }
assert_alert_lines() {
  local actual=0
  [[ ! -f "$(alerts_file)" ]] || actual="$(wc -l <"$(alerts_file)")"
  if [[ "$actual" -eq "$1" ]]; then return 0; fi
  printf '  alerts.jsonl の行数: 期待 %s / 実際 %s\n' "$1" "$actual" >&2
  [[ ! -f "$(alerts_file)" ]] || sed 's/^/    /' "$(alerts_file)" >&2
  return 1
}
# 最終行が {"at","unit","result"} だけの JSON で、指定の unit/result を持つこと
assert_last_alert() { # <unit> <result>
  node -e '
    const fs = require("node:fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n");
    const j = JSON.parse(lines[lines.length - 1]);
    const keys = Object.keys(j).sort().join(",");
    const ok = keys === "at,result,unit" && j.unit === process.argv[2] && j.result === process.argv[3] &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(j.at);
    if (!ok) { console.error("  最終行: " + lines[lines.length - 1]); process.exit(1); }
  ' "$(alerts_file)" "$1" "$2"
}

BODY="$(node "$GEN" --body)"

setup_case() { # <name>
  CASE="$TMP/$1"
  HOME_DIR="$CASE/home"
  mkdir -p "$HOME_DIR"
}
# unit の ExecStart と同じ形（/bin/sh -c <本文> mirai-sf-onfailure <unit>）で実行する
run_notify() { # <unit 名> [MONITOR_SERVICE_RESULT]
  OUT="$(
    env -i PATH="/usr/local/bin:/usr/bin:/bin" HOME="$HOME_DIR" \
      ${2+MONITOR_SERVICE_RESULT="$2"} \
      /bin/sh -c "$BODY" mirai-sf-onfailure "$1" 2>&1
  )"
  CODE=$?
}
write_notify_env() { # <cmd 行の値> [mode]
  mkdir -p "$HOME_DIR/.config/mirai-sf"
  printf '# 作り物の設定\nMIRAI_SF_NOTIFY_TOKEN=%s\nMIRAI_SF_NOTIFY_CMD=%s\n' "$MARKER" "$1" >"$HOME_DIR/.config/mirai-sf/notify.env"
  chmod "${2:-600}" "$HOME_DIR/.config/mirai-sf/notify.env"
}
write_fake_cmd() { # <exit code>
  cat >"$CASE/notify-cmd.sh" <<EOS
#!/bin/sh
printf '%s|%s|%s\n' "\$1" "\$2" "\$3" >>"$CASE/notify-invocations"
echo "$MARKER" # 送信コマンドの出力は表示されないこと
exit $1
EOS
  chmod 700 "$CASE/notify-cmd.sh"
}

printf '== 静的検査 ==\n'
if bash -n "${BASH_SOURCE[0]}"; then pass "bash -n テストスクリプト"; else fail "bash -n テストスクリプト"; fi
if printf '%s\n' "$BODY" | /bin/sh -n; then pass "/bin/sh -n 通知本文"; else fail "/bin/sh -n 通知本文"; fi
EXPECTED="$(node "$GEN")"
ACTUAL="$(grep '^ExecStart=' "$UNIT")"
if [[ "$ACTUAL" == "$EXPECTED" ]]; then
  pass "unit の ExecStart は正本（body.sh）をエスケープした結果と一致する"
else
  fail "unit の ExecStart が正本と一致しません。次の行を unit へ貼ってください:"
  printf '%s\n' "$EXPECTED"
fi
if grep -Eq 'scripts/|Software-Factory|node |bash ' <<<"$ACTUAL"; then
  fail "ExecStart が git ワークツリーのスクリプトに依存しています"
else
  pass "ExecStart は git ワークツリーのスクリプトに依存しない（/bin/sh のみ）"
fi
if grep -qx 'OnFailure=' "$UNIT"; then pass "通知 unit 自身は OnFailure を空にする（再帰しない）"; else fail "通知 unit 自身の OnFailure= が空でない"; fi
for u in mirai-sf-prod-healthcheck mirai-sf-prod-backup mirai-sf-prod-restore-drill mirai-sf-healthcheck mirai-sf-autofollow; do
  if grep -qx 'OnFailure=mirai-sf-onfailure@%n.service' "$ROOT/deploy/systemd/$u.service"; then
    pass "$u.service に OnFailure=mirai-sf-onfailure@%n.service がある"
  else
    fail "$u.service に OnFailure=mirai-sf-onfailure@%n.service がない"
  fi
done
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -x "${BASH_SOURCE[0]}"; then pass "shellcheck テストスクリプト"; else fail "shellcheck テストスクリプト"; fi
  if shellcheck -s sh "$BODY_SRC"; then pass "shellcheck 通知本文（sh）"; else fail "shellcheck 通知本文（sh）"; fi
elif [[ "${CI:-}" == true ]]; then
  fail "shellcheck が見つかりません（CI=true では必須）"
else
  printf 'SKIP: shellcheck が無いため構文検査のみ（ローカルのみ許容。CI=true では FAIL）\n'
fi
if command -v systemd-analyze >/dev/null 2>&1 && [[ -n "${XDG_RUNTIME_DIR:-}" && -d "${XDG_RUNTIME_DIR:-}" ]]; then
  # --user verify は user manager の RuntimeDirectory を要する。CI ランナー（ユーザーセッション無し）では
  # 「Failed to lookup RuntimeDirectory path」で必ず失敗するため、セッションがある環境だけで実行する。
  # 構文の正しさは ExecStart と正本の一致検査（上）とローカル実行で担保する
  mkdir -p "$TMP/analyze"
  cp "$UNIT" "$TMP/analyze/mirai-sf-onfailure@test.service"
  if systemd-analyze --user verify "$TMP/analyze/mirai-sf-onfailure@test.service" >"$TMP/analyze/out" 2>&1; then
    pass "systemd-analyze verify（instance=test）"
  else
    fail "systemd-analyze verify（instance=test）: $(head -n 3 "$TMP/analyze/out")"
  fi
else
  printf 'SKIP: systemd-analyze かユーザーセッション（XDG_RUNTIME_DIR）が無いため unit の構文検査は省略\n'
fi

printf '\n== O1. 偽 unit の失敗を alerts.jsonl に 1 行記録する（notify.env なし） ==\n'
setup_case record
run_notify mirai-sf-fake-healthcheck.service exit-code
check "notify.env なしで終了コード 0" assert_code 0
check "alerts.jsonl に 1 行追記" assert_alert_lines 1
check "記録は at/unit/result だけ" assert_last_alert mirai-sf-fake-healthcheck.service exit-code
check "journal 用に priority=err（<3>）で出す" assert_out_contains "<3>[mirai-sf-onfailure] 失敗を検知: unit=mirai-sf-fake-healthcheck.service result=exit-code"
check "外部送信なしを表示する" assert_out_contains "外部送信なし（notify.env が無い）"
if [[ "$(stat -c %a "$(alerts_file)")" == 600 ]]; then pass "alerts.jsonl は 0600"; else fail "alerts.jsonl が 0600 でない: $(stat -c %a "$(alerts_file)")"; fi

printf '\n== O2. 2 回目は追記する（上書きしない） ==\n'
run_notify mirai-sf-prod-backup.service timeout
check "2 回目も終了コード 0" assert_code 0
check "alerts.jsonl は 2 行" assert_alert_lines 2
check "2 行目は 2 回目の unit/result" assert_last_alert mirai-sf-prod-backup.service timeout

printf '\n== O3. unit 名の改行注入を拒否する ==\n'
setup_case inject_newline
run_notify $'mirai-sf-x.service\n{"at":"x","unit":"forged","result":"success"}' exit-code
check "改行入り unit 名は終了コード 2" assert_code 2
check "改行入り unit 名は記録しない" assert_alert_lines 0
check "拒否をログに出す" assert_out_contains "unit 名が不正"

printf '\n== O4. unit 名の引用符・シェル記号を拒否する ==\n'
setup_case inject_quote
# shellcheck disable=SC2016 # 展開させない文字列そのものを渡す
run_notify 'a",\"unit\":\"x$(touch pwned).service' exit-code
check "記号入り unit 名は終了コード 2" assert_code 2
check "記号入り unit 名は記録しない" assert_alert_lines 0
if [[ ! -e "$HOME_DIR/pwned" && ! -e "$CASE/pwned" ]]; then pass "コマンド置換は実行されない"; else fail "コマンド置換が実行された"; fi

printf '\n== O5. 空の unit 名を拒否する ==\n'
setup_case empty
run_notify ''
check "空の unit 名は終了コード 2" assert_code 2
check "空の unit 名は記録しない" assert_alert_lines 0

printf '\n== O6. Result の改行注入は unknown に丸める ==\n'
setup_case inject_result
run_notify mirai-sf-healthcheck.service $'exit-code\n{"forged":true}'
check "Result 注入でも終了コード 0" assert_code 0
check "alerts.jsonl は 1 行のまま" assert_alert_lines 1
check "Result は unknown" assert_last_alert mirai-sf-healthcheck.service unknown

printf '\n== O7. MONITOR_SERVICE_RESULT が無ければ unknown ==\n'
setup_case no_result
run_notify mirai-sf-autofollow.service
check "Result 無しでも終了コード 0" assert_code 0
check "Result は unknown" assert_last_alert mirai-sf-autofollow.service unknown

printf '\n== O8. notify.env に MIRAI_SF_NOTIFY_CMD が無ければ送信しない ==\n'
setup_case env_nocmd
mkdir -p "$HOME_DIR/.config/mirai-sf"
printf 'MIRAI_SF_NOTIFY_TOKEN=%s\n' "$MARKER" >"$HOME_DIR/.config/mirai-sf/notify.env"
chmod 600 "$HOME_DIR/.config/mirai-sf/notify.env"
run_notify mirai-sf-healthcheck.service exit-code
check "CMD 無しは終了コード 0" assert_code 0
check "CMD 無しを表示する" assert_out_contains "MIRAI_SF_NOTIFY_CMD が未設定"
check "notify.env の値を出さない" assert_out_not_contains "$MARKER"

printf '\n== O9. MIRAI_SF_NOTIFY_CMD があれば実行する（値・出力は表示しない） ==\n'
setup_case send_ok
write_fake_cmd 0
write_notify_env "$CASE/notify-cmd.sh"
run_notify mirai-sf-prod-healthcheck.service exit-code
check "送信 OK で終了コード 0" assert_code 0
check "ローカル記録もする" assert_alert_lines 1
if grep -Eq '^mirai-sf-prod-healthcheck\.service\|exit-code\|[0-9T:-]+Z$' "$CASE/notify-invocations" 2>/dev/null; then
  pass "送信コマンドに unit/result/at を渡す"
else
  fail "送信コマンドの引数が不正: $(cat "$CASE/notify-invocations" 2>/dev/null)"
fi
check "送信 OK を表示する" assert_out_contains "外部送信 OK"
check "notify.env の値・コマンド出力を出さない" assert_out_not_contains "$MARKER"
check "送信コマンドのパスを出さない" assert_out_not_contains "notify-cmd.sh"

printf '\n== O10. 送信コマンドの失敗は終了コード 4（ローカル記録は済み） ==\n'
setup_case send_fail
write_fake_cmd 9
write_notify_env "$CASE/notify-cmd.sh"
run_notify mirai-sf-prod-backup.service exit-code
check "送信失敗は終了コード 4" assert_code 4
check "送信失敗でもローカル記録は 1 行" assert_alert_lines 1
check "送信失敗を表示する" assert_out_contains "外部送信に失敗（exit=9"

printf '\n== O11. notify.env の権限が group/other に開いていれば送信しない（0600 以下だけ許可） ==\n'
for mode in 666 644 640 604 660 620 602 700; do
  setup_case "env_perm_$mode"
  write_fake_cmd 0
  write_notify_env "$CASE/notify-cmd.sh" "$mode"
  run_notify mirai-sf-prod-backup.service exit-code
  if [[ "$mode" == 700 ]]; then
    # group/other ビットが無ければ許可（実行ビットは本人だけ）
    check "notify.env $mode は送信する（終了コード 0）" assert_code 0
    continue
  fi
  check "notify.env $mode は終了コード 4" assert_code 4
  check "notify.env $mode でもローカル記録は 1 行" assert_alert_lines 1
  check "notify.env $mode は権限不正を表示する" assert_out_contains "group/other に開いている"
  if [[ ! -s "$CASE/notify-invocations" ]]; then pass "notify.env $mode では送信コマンドを実行しない"; else fail "notify.env $mode なのに送信コマンドを実行した"; fi
done
setup_case env_perm_400
write_fake_cmd 0
write_notify_env "$CASE/notify-cmd.sh" 400
run_notify mirai-sf-prod-backup.service exit-code
check "notify.env 400（読取専用・本人のみ）は送信する" assert_code 0

printf '\n== O11b. notify.env がディレクトリなら送信しない ==\n'
setup_case env_dir
mkdir -p "$HOME_DIR/.config/mirai-sf/notify.env"
chmod 700 "$HOME_DIR/.config/mirai-sf/notify.env"
run_notify mirai-sf-prod-backup.service exit-code
check "ディレクトリは終了コード 4" assert_code 4
check "ディレクトリでもローカル記録は 1 行" assert_alert_lines 1
check "通常ファイルでないことを表示する" assert_out_contains "通常ファイルではない"

printf '\n== O11c. notify.env が symlink なら送信しない（0600 のファイルを指していても） ==\n'
setup_case env_symlink
write_fake_cmd 0
write_notify_env "$CASE/notify-cmd.sh"
mv "$HOME_DIR/.config/mirai-sf/notify.env" "$CASE/real-notify.env"
ln -s "$CASE/real-notify.env" "$HOME_DIR/.config/mirai-sf/notify.env"
run_notify mirai-sf-prod-backup.service exit-code
check "symlink は終了コード 4" assert_code 4
if [[ ! -s "$CASE/notify-invocations" ]]; then pass "symlink では送信コマンドを実行しない"; else fail "symlink なのに送信コマンドを実行した"; fi

printf '\n== O11d. 壊れた symlink も送信しない（無いものとして扱わない） ==\n'
setup_case env_dangling
mkdir -p "$HOME_DIR/.config/mirai-sf"
ln -s "$CASE/missing.env" "$HOME_DIR/.config/mirai-sf/notify.env"
run_notify mirai-sf-prod-backup.service exit-code
check "壊れた symlink は終了コード 4" assert_code 4

printf '\n== O11e. notify.env が読めなければ送信しない ==\n'
setup_case env_unreadable
write_fake_cmd 0
write_notify_env "$CASE/notify-cmd.sh" 200
run_notify mirai-sf-prod-backup.service exit-code
if [[ -r "$HOME_DIR/.config/mirai-sf/notify.env" ]]; then
  # root で実行すると権限に関係なく読めるため、この経路は検証できない。
  # CI では検証の欠落を成功扱いにしない（非 root で実行する）。ローカルは SKIP を許す
  if [[ "${CI:-}" == true ]]; then
    fail "読取不能 fixture を作れません（root 実行。CI=true では非 root で実行する）"
  else
    printf 'SKIP: 読取不能を作れない（root 実行。CI=true では FAIL）\n'
  fi
else
  check "読取不能は終了コード 4" assert_code 4
  check "読取不能を表示する" assert_out_contains "notify.env を読めない"
  if [[ ! -s "$CASE/notify-invocations" ]]; then pass "読取不能では送信コマンドを実行しない"; else fail "読取不能なのに送信コマンドを実行した"; fi
fi

printf '\n== O11f. 親ディレクトリ ~/.config/mirai-sf が group/other に書込み可能なら送信しない（TOCTOU 対策） ==\n'
for mode in 777 775 757 730 703; do
  setup_case "cfgdir_perm_$mode"
  write_fake_cmd 0
  write_notify_env "$CASE/notify-cmd.sh"
  chmod "$mode" "$HOME_DIR/.config/mirai-sf"
  run_notify mirai-sf-prod-backup.service exit-code
  check "HOME/.config/mirai-sf $mode は終了コード 4" assert_code 4
  check "HOME/.config/mirai-sf $mode でもローカル記録は 1 行" assert_alert_lines 1
  check "HOME/.config/mirai-sf $mode は親ディレクトリ不正を表示する" assert_out_contains "group/other に書込み可能"
  if [[ ! -s "$CASE/notify-invocations" ]]; then pass "HOME/.config/mirai-sf $mode では送信コマンドを実行しない"; else fail "HOME/.config/mirai-sf $mode なのに送信コマンドを実行した"; fi
done
for mode in 700 750 755 711; do
  setup_case "cfgdir_ok_$mode"
  write_fake_cmd 0
  write_notify_env "$CASE/notify-cmd.sh"
  chmod "$mode" "$HOME_DIR/.config/mirai-sf"
  run_notify mirai-sf-prod-backup.service exit-code
  check "HOME/.config/mirai-sf $mode（group/other 書込みなし）は送信する" assert_code 0
done

printf '\n== O11g. ~/.config が group/other に書込み可能なら送信しない ==\n'
setup_case config_perm
write_fake_cmd 0
write_notify_env "$CASE/notify-cmd.sh"
chmod 777 "$HOME_DIR/.config"
run_notify mirai-sf-prod-backup.service exit-code
check "HOME/.config 777 は終了コード 4" assert_code 4
if [[ ! -s "$CASE/notify-invocations" ]]; then pass "HOME/.config 777 では送信コマンドを実行しない"; else fail "HOME/.config 777 なのに送信コマンドを実行した"; fi

printf '\n== O11h. ~/.config/mirai-sf が symlink なら送信しない ==\n'
setup_case cfgdir_symlink
write_fake_cmd 0
write_notify_env "$CASE/notify-cmd.sh"
mv "$HOME_DIR/.config/mirai-sf" "$CASE/real-cfgdir"
ln -s "$CASE/real-cfgdir" "$HOME_DIR/.config/mirai-sf"
run_notify mirai-sf-prod-backup.service exit-code
check "HOME/.config/mirai-sf の symlink は終了コード 4" assert_code 4
if [[ ! -s "$CASE/notify-invocations" ]]; then pass "HOME/.config/mirai-sf の symlink では送信コマンドを実行しない"; else fail "HOME/.config/mirai-sf の symlink なのに送信コマンドを実行した"; fi

printf '\n== O11i. 親ディレクトリを探索できない（x 権限なし）なら「無い」と誤認せず exit 4 ==\n'
for target in mirai-sf config; do
  for mode in 600 400 000; do
    setup_case "cfgdir_noexec_${target}_$mode"
    write_fake_cmd 0
    write_notify_env "$CASE/notify-cmd.sh"
    if [[ "$target" == mirai-sf ]]; then dpath="$HOME_DIR/.config/mirai-sf"; else dpath="$HOME_DIR/.config"; fi
    chmod "$mode" "$dpath"
    run_notify mirai-sf-prod-backup.service exit-code
    chmod 700 "$dpath" # 後片付け（rm -rf できるように戻す）
    label="HOME/.$([[ "$target" == config ]] && echo config || echo config/mirai-sf) $mode"
    if [[ "$(id -u)" == 0 ]]; then
      # root は x 権限が無くても探索できるため、この経路は検証できない
      if [[ "${CI:-}" == true ]]; then fail "$label: 探索不能 fixture を作れません（root 実行。CI=true では非 root で実行する）"; else printf 'SKIP: %s（root 実行）\n' "$label"; fi
      continue
    fi
    check "$label（探索不能）は終了コード 4（外部送信なしの 0 ではない）" assert_code 4
    check "$label でもローカル記録は 1 行" assert_alert_lines 1
    check "$label は探索不能を表示する" assert_out_contains "探索できない"
    check "$label は「notify.env が無い」と表示しない" assert_out_not_contains "notify.env が無い"
  done
done

printf '\n== O11j. ~/.config・~/.config/mirai-sf 自体が無ければ「設定なし」で exit 0 ==\n'
setup_case no_config_root
run_notify mirai-sf-prod-backup.service exit-code
check "HOME/.config が無ければ終了コード 0" assert_code 0
check "HOME/.config が無ければ外部送信なしを表示する" assert_out_contains "notify.env が無い"
setup_case no_cfgdir
mkdir -p "$HOME_DIR/.config"
chmod 700 "$HOME_DIR/.config"
run_notify mirai-sf-prod-backup.service exit-code
check "HOME/.config/mirai-sf が無ければ終了コード 0" assert_code 0

printf '\n== O12. 相対パスの MIRAI_SF_NOTIFY_CMD は実行しない ==\n'
setup_case env_relative
write_notify_env "notify-cmd.sh"
run_notify mirai-sf-prod-backup.service exit-code
check "相対パスは終了コード 4" assert_code 4
check "相対パスの値を出さない" assert_out_not_contains "notify-cmd.sh"

printf '\n== O13. ローカル記録できなければ終了コード 3 ==\n'
setup_case unwritable
mkdir -p "$HOME_DIR/.local/state"
: >"$HOME_DIR/.local/state/mirai-sf" # ディレクトリの位置にファイルを置く
run_notify mirai-sf-prod-backup.service exit-code
check "記録不能は終了コード 3" assert_code 3
check "記録不能を priority=err で出す" assert_out_contains "<3>[mirai-sf-onfailure] 失敗を検知しましたがローカル記録に失敗"

printf '\n== 結果: PASS %d / FAIL %d ==\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]]
