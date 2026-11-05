# shellcheck shell=sh
# mirai-sf-onfailure@.service の ExecStart 本文の正本（読める形）。
#
# このファイルは systemd からは直接実行しない。mirai-sf-onfailure@.service の ExecStart は、
# この本文から「# で始まる行と空行を除き、各行を空白1つで連結し、systemd の引用規則で
# エスケープした」1 行である（\ → \\、" → \"、$ → $$、% → %%）。
# scripts/ops/tests/onfailure-notify.test.sh がこの対応（本文と ExecStart 行の一致）を検証する。
# 本文を変えたらテストを実行し、失敗メッセージに出る期待値を unit へ貼る。手でエスケープしない。
#
# 連結するため、各行は ; / then / do / else などで終えること（行をまたぐ文を書かない）。
#
# 引数: $1 = 失敗した unit 名（ExecStart の %i。systemd が別の引数として渡す。シェルの本文には埋め込まない）
# 環境: MONITOR_SERVICE_RESULT（systemd 251 以降が OnFailure= の unit に渡す失敗理由。無ければ unknown）
#
# 終了コード: 0=ローカル記録済み（外部送信なし、または外部送信 OK）
#             2=unit 名が不正（改行・記号を含む。記録しない）
#             3=ローカル記録に失敗
#             4=外部送信の設定不正または送信失敗（ローカル記録は済み）
# 2〜4 はこの unit 自体を failed にする（通知経路の異常を成功で隠さない）。
#
# git ワークツリーのスクリプトには依存しない（/bin/sh と coreutils/sed/find だけ）。
set -u;
umask 077;
unit="${1:-}";
case "$unit" in '' | *[!A-Za-z0-9@._:-]*) echo "<3>[mirai-sf-onfailure] unit 名が不正なため記録しません（空・改行・記号を含む）" >&2; exit 2 ;; esac;
if [ "${#unit}" -gt 256 ]; then echo "<3>[mirai-sf-onfailure] unit 名が長すぎるため記録しません" >&2; exit 2; fi;
result="${MONITOR_SERVICE_RESULT:-}";
case "$result" in '' | *[!a-z-]*) result=unknown ;; esac;
if [ "${#result}" -gt 40 ]; then result=unknown; fi;
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)";
case "${HOME:-}" in /*) ;; *) echo "<3>[mirai-sf-onfailure] 失敗を検知しましたが HOME が不正なため記録できません: unit=$unit result=$result at=$ts" >&2; exit 3 ;; esac;
dir="$HOME/.local/state/mirai-sf";
if mkdir -p "$dir" && printf '{"at":"%s","unit":"%s","result":"%s"}\n' "$ts" "$unit" "$result" >>"$dir/alerts.jsonl"; then echo "<3>[mirai-sf-onfailure] 失敗を検知: unit=$unit result=$result at=$ts（記録: ~/.local/state/mirai-sf/alerts.jsonl）" >&2; else echo "<3>[mirai-sf-onfailure] 失敗を検知しましたがローカル記録に失敗: unit=$unit result=$result at=$ts" >&2; exit 3; fi;
envf="$HOME/.config/mirai-sf/notify.env";
if [ ! -e "$envf" ]; then echo "[mirai-sf-onfailure] 外部送信なし（notify.env が無い）: unit=$unit"; exit 0; fi;
cmd="$(sed -n 's/^MIRAI_SF_NOTIFY_CMD=//p' "$envf" 2>/dev/null | tail -n 1 | tr -d "\"'\r")";
if [ -z "$cmd" ]; then echo "[mirai-sf-onfailure] 外部送信なし（MIRAI_SF_NOTIFY_CMD が未設定）: unit=$unit"; exit 0; fi;
if [ ! -O "$envf" ] || [ -n "$(find "$envf" -maxdepth 0 -perm /022 2>/dev/null)" ]; then echo "<3>[mirai-sf-onfailure] notify.env の所有者または権限が不正なため外部送信しません（本人所有・0600 にする）: unit=$unit" >&2; exit 4; fi;
case "$cmd" in /*) ;; *) echo "<3>[mirai-sf-onfailure] MIRAI_SF_NOTIFY_CMD は絶対パスで指定してください（値は表示しません）: unit=$unit" >&2; exit 4 ;; esac;
if [ ! -x "$cmd" ]; then echo "<3>[mirai-sf-onfailure] MIRAI_SF_NOTIFY_CMD を実行できません（値は表示しません）: unit=$unit" >&2; exit 4; fi;
rc=0;
timeout 30 "$cmd" "$unit" "$result" "$ts" </dev/null >/dev/null 2>&1 || rc=$?;
if [ "$rc" -eq 0 ]; then echo "[mirai-sf-onfailure] 外部送信 OK: unit=$unit"; exit 0; fi;
echo "<3>[mirai-sf-onfailure] 外部送信に失敗（exit=$rc。ローカル記録は済み）: unit=$unit" >&2;
exit 4
