#!/usr/bin/env bash
# 本番の全体 RTO 訓練（リハーサル）。本番を止めずに「検知→判断→別DBへ最新 dump 復元→検証→切替判断」
# までを段階ごとに時刻計測し、JSON で出力する。
#
#   scripts/ops/rto-drill.sh [--dry-run] [--local]      # または pnpm ops:prod:rto-drill
#
#   --dry-run  前提の確認と計画の表示だけ（R2 取得・DB 作成・API 起動をしない。レポートファイルも書かない）
#   --local    R2 ではなくローカルの最新 dump（MIRAI_SF_BACKUP_DIR）を使う（R2 の認証が使えないときの代替）
#
# 段階（stages）:
#   detect           検知: 監視の状態（prod healthcheck.json・alerts.jsonl）を読む（訓練では宣言時刻を検知時刻とする）
#   decide           判断: current リリース・最新の R2 送信記録（または local dump）・一時ポート・一時DB名を確定
#   fetch            R2 から dump と manifest を取得し、送信記録の SHA-256・サイズと照合（offsite-drill と同等）
#   restore          一時DB mirai_sf_rto_<ts> を作って pg_restore
#   verify           manifest（件数・監査ログ末尾ハッシュ）との完全一致と scripts/db.ts verify（ハッシュ連鎖）
#   api              current リリースの API を一時DB・一時ポート（既定 127.0.0.1:8789）で起動し、
#                    /healthz が status=ok・db.ok=true・commit 一致になるまで計測
#   switch_decision  切替判断（判断の記録だけ。本番の切替・DNS・Access・サービスは変更しない）
#   cleanup          一時 API を停止し、一時DBを削除（名前が mirai_sf_rto_ で始まることを検査してから DROP）
#
# 秘密の扱い: prod.conf の値は with-env.mjs 経由で環境変数として読むだけで、表示しない。
# 一時 API へは DATABASE_URL を一時DBへ上書きし、PORT/HOST/MAIL_MODE=off も上書きして渡す。
# API・wrangler の出力本文は表示しない（終了コードと固定の分類だけ）。
# 本番DBへは接続しない（DATABASE_URL は接続先とDB名の特定、--maintenance-db=postgres での createdb/dropdb にだけ使う）。
#
# 環境変数:
#   MIRAI_SF_PROD_HOME / MIRAI_SF_PROD_ENV_FILE / MIRAI_SF_PROD_BACKUP_DIR   prod-*.sh と同じ（既定は本番の場所）
#   MIRAI_SF_RTO_PORT            一時 API のポート（既定 8789。8781/8782/8783 は不可）
#   MIRAI_SF_RTO_HEALTH_TIMEOUT  /healthz を待つ秒数（既定 60）
#   MIRAI_SF_RTO_TARGET_MIN      RTO の目標（分。既定 30。docs/production/07 の案）
#   MIRAI_SF_RTO_REPORT_DIR      レポートの保存先（既定 ~/.local/state/mirai-sf-prod/rto-drill。0600）。保存は任意で、
#                                失敗しても終了コードは変えず JSON の reportSaved=false で示す（標準出力の JSON が正本）
#   MIRAI_SF_RTO_HEALTH_STATE    検知段階で読む healthcheck 状態（既定 ~/.local/state/mirai-sf-prod/healthcheck.json）
#   MIRAI_SF_WRANGLER / MIRAI_SF_R2_API_TOKEN / MIRAI_SF_PG_BIN_DIR / MIRAI_SF_NODE_BIN_DIR  既存スクリプトと同じ
#
# 出力: 標準出力には JSON（レポート）だけを出す。進行ログは標準エラーへ出す。
# 終了コード: 0=成功（dry-run は前提 OK）/ 1=失敗（一時DBは削除済み。dry-run は前提 NG）
#             / 2=一時DBを削除できなかった（手動で dropdb する。名前はログと JSON の tempDb に出て、
#               tempDbRemaining=true になる）
set -euo pipefail
umask 077

RTO_DB_PATTERN='^mirai_sf_rto_[0-9a-z_]+$'

# 一時DB名の検査。CREATE/DROP の前に必ず通す（本番DB・他の DB を消さないため）。
#   引数: <一時DB名> <復元元（本番）DB名>
rto_db_name_ok() {
  [[ "$1" =~ $RTO_DB_PATTERN ]] && [[ "$1" != "$2" ]] && [[ "${#1}" -le 63 ]]
}

rto_usage() {
  awk 'NR > 1 && /^set -euo pipefail$/ { exit } NR > 1 { print }' "${BASH_SOURCE[0]}"
}

# 時刻（ミリ秒）。壁時計は NTP 補正等で逆行しうる（CI ランナーで実測）ため、前回値を下回らないよう丸めて
# RTO_NOW に入れる（サブシェルでは前回値を更新できないので $(...) で呼ばない）。
RTO_LAST_MS=0
rto_tick() {
  local t
  t="$(date +%s%3N)"
  ((t >= RTO_LAST_MS)) || t="$RTO_LAST_MS"
  RTO_LAST_MS="$t"
  RTO_NOW="$t"
}

rto_main() {
  local dry_run=0 source_kind=r2 arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) dry_run=1 ;;
      --local) source_kind=local ;;
      -h | --help) rto_usage; exit 0 ;;
      *) printf 'エラー: 不明な引数: %s（--dry-run / --local のみ）\n' "$arg" >&2; exit 1 ;;
    esac
  done

  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # prod.conf は with-env 経由でだけ読む（値を表示しない）。最初に 1 回だけ自分を with-env の下で実行し直す。
  if [[ "${MIRAI_SF_RTO_ENV_LOADED:-}" != 1 ]]; then
    export MIRAI_SF_HOME="${MIRAI_SF_PROD_HOME:-$HOME/.local/share/mirai-sf-prod}"
    export MIRAI_SF_ENV_FILE="${MIRAI_SF_PROD_ENV_FILE:-$HOME/.config/mirai-sf/prod.conf}"
    export MIRAI_SF_BACKUP_DIR="${MIRAI_SF_PROD_BACKUP_DIR:-$HOME/.local/state/mirai-sf-prod/backups}"
    export MIRAI_SF_RTO_ENV_LOADED=1
    exec node "$here/with-env.mjs" bash "$here/rto-drill.sh" "$@"
  fi

  # 標準出力は JSON 専用（fd 3）。進行ログ（lib.sh の log）は標準エラーへ。
  exec 3>&1 1>&2

  # shellcheck source=scripts/ops/lib.sh
  source "$here/lib.sh"
  ops_use_node
  ops_load_db
  local source_db="$OPS_DB_NAME"
  # 以降、接続先は -d / --maintenance-db で明示する（本番DBを既定にしない）
  unset PGDATABASE

  RTO_MODE="$([[ "$dry_run" == 1 ]] && echo dry-run || echo run)"
  RTO_SOURCE="$source_kind"
  RTO_RESULT=failed
  RTO_DECISION=""
  rto_tick
  RTO_STARTED_MS="$RTO_NOW"
  RTO_BACKUP=""
  RTO_BACKUP_AGE_MIN=""
  RTO_COMMIT=""
  RTO_PORT="${MIRAI_SF_RTO_PORT:-8789}"
  RTO_TARGET_MIN="${MIRAI_SF_RTO_TARGET_MIN:-30}"
  RTO_DB="mirai_sf_rto_$(date -u +%Y%m%dt%H%M%Sz)_$$"
  RTO_SOURCE_DB="$source_db"
  RTO_CREATED=0
  RTO_TEMP_DB_LEFT=0
  RTO_API_PID=""
  RTO_STAGE=""
  RTO_STAGE_LABEL=""
  RTO_STAGE_START=0
  RTO_WORK="$(mktemp -d)"
  RTO_REPORT_DIR="${MIRAI_SF_RTO_REPORT_DIR:-$HOME/.local/state/mirai-sf-prod/rto-drill}"
  : >"$RTO_WORK/stages.tsv"
  trap rto_finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  [[ "$RTO_TARGET_MIN" =~ ^[0-9]{1,5}$ ]] || RTO_TARGET_MIN=30
  local health_timeout="${MIRAI_SF_RTO_HEALTH_TIMEOUT:-60}"
  [[ "$health_timeout" =~ ^[0-9]{1,4}$ ]] || health_timeout=60

  log "RTO 訓練 開始 mode=$RTO_MODE source=$source_kind source_db=$source_db temp_db=$RTO_DB port=$RTO_PORT"
  log "本番DB・本番サービス・DNS/Access は変更しません（一時DBと一時ポートだけを使います）"

  # ───── 1. 検知 ─────
  rto_stage_begin detect "検知（監視状態の確認。訓練では宣言時刻を検知時刻とする）"
  local health_state="${MIRAI_SF_RTO_HEALTH_STATE:-$HOME/.local/state/mirai-sf-prod/healthcheck.json}"
  local alerts="$HOME/.local/state/mirai-sf/alerts.jsonl" detect_note health_summary alert_count=0
  if [[ -r "$health_state" ]]; then
    # shellcheck disable=SC2016 # JavaScript のテンプレート文字列（シェルでは展開しない）
    health_summary="$(node -e '
      try {
        const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
        const n = Number.isSafeInteger(s.consecutiveFailures) ? s.consecutiveFailures : -1;
        process.stdout.write(`ok=${s.ok === true} consecutiveFailures=${n}`);
      } catch { process.stdout.write("読めない"); }
    ' "$health_state")"
    detect_note="healthcheck.json: $health_summary"
  else
    detect_note="healthcheck.json: なし"
  fi
  [[ ! -r "$alerts" ]] || alert_count="$(wc -l <"$alerts")"
  detect_note="$detect_note / alerts.jsonl: ${alert_count} 行"
  rto_stage_end true "$detect_note"

  # ───── 2. 判断 ─────
  rto_stage_begin decide "判断（復元元・リリース・一時DB・一時ポートの確定）"
  rto_db_name_ok "$RTO_DB" "$source_db" || rto_fail_stage "一時DB名が不正です（mirai_sf_rto_ で始まり、本番DB名と異なること）"

  [[ "$RTO_PORT" =~ ^[0-9]{4,5}$ ]] || rto_fail_stage "MIRAI_SF_RTO_PORT が不正です"
  case "$RTO_PORT" in 8781 | 8782 | 8783) rto_fail_stage "一時ポートに開発・Staging・本番のポート（$RTO_PORT）は使えません" ;; esac
  if rto_port_in_use "$RTO_PORT"; then
    rto_fail_stage "一時ポート 127.0.0.1:$RTO_PORT は使用中です（別のプロセスを止めるか MIRAI_SF_RTO_PORT を変える）"
  fi

  local current_link="$OPS_HOME/current" release_dir
  [[ -L "$current_link" ]] || rto_fail_stage "current リリースがありません: $current_link"
  release_dir="$(readlink -f "$current_link")"
  RTO_COMMIT="$(basename "$release_dir")"
  [[ "$RTO_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { RTO_COMMIT=""; rto_fail_stage "current が commit のリリースを指していません"; }
  [[ -f "$release_dir/dist/api/server.js" ]] || rto_fail_stage "current に dist/api/server.js がありません（ビルド済みのリリースが必要）"
  grep -qx "COMMIT_SHA=$RTO_COMMIT" "$release_dir/release.env" 2>/dev/null ||
    rto_fail_stage "current/release.env の COMMIT_SHA がリリースと一致しません"

  local backup_dir="${MIRAI_SF_BACKUP_DIR:?}" dump="" manifest="" wrangler="" bucket=""
  local dump_key="" dump_size="" dump_sha="" manifest_key="" manifest_size="" manifest_sha=""
  [[ -d "$backup_dir" ]] || rto_fail_stage "バックアップの保存先がありません"
  if [[ "$source_kind" == r2 ]]; then
    local marker="" marker_fields
    marker="$(find "$backup_dir" -maxdepth 1 -type f -name '*.dump.r2.json' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-)"
    [[ -n "$marker" ]] || rto_fail_stage "R2 へ送った記録（*.dump.r2.json）がありません（--local でローカル dump を使えます）"
    marker_fields="$(node -e '
      const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const key = (v) => typeof v === "string" && /^[A-Za-z0-9._/-]{1,200}$/.test(v) && !v.includes("..");
      const sha = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
      const size = (v) => Number.isSafeInteger(v) && v > 0;
      const bucket = m.bucket ?? process.env.MIRAI_SF_R2_BUCKET ?? "mirai-sf-prod-backups";
      const at = Date.parse(m.uploadedAt);
      if (!/^[a-z0-9-]{3,63}$/.test(bucket) || !key(m.dump?.key) || !key(m.manifest?.key) || !sha(m.dump?.sha256) ||
          !sha(m.manifest?.sha256) || !size(m.dump?.size) || !size(m.manifest?.size) || !Number.isFinite(at)) process.exit(1);
      const age = Math.max(0, Math.floor((Date.now() - at) / 60000));
      process.stdout.write([bucket, m.dump.key, m.dump.size, m.dump.sha256, m.manifest.key, m.manifest.size, m.manifest.sha256, age].join("\t"));
    ' "$marker" 2>/dev/null)" || rto_fail_stage "送信記録の形が不正です: $(basename "$marker")"
    IFS=$'\t' read -r bucket dump_key dump_size dump_sha manifest_key manifest_size manifest_sha RTO_BACKUP_AGE_MIN <<<"$marker_fields"
    RTO_BACKUP="$(basename "$dump_key")"
    wrangler="$(rto_resolve_wrangler)" || rto_fail_stage "wrangler が見つかりません（MIRAI_SF_WRANGLER でパスを指定、または --local）"
  else
    local file
    shopt -s nullglob
    for file in "$backup_dir/$source_db"-*.dump; do
      [[ "$(basename "$file")" =~ ^${source_db}-[0-9]{8}T[0-9]{6}Z\.dump$ ]] && dump="$file"
    done
    shopt -u nullglob
    [[ -n "$dump" ]] || rto_fail_stage "ローカルのバックアップがありません: db=$source_db"
    manifest="${dump%.dump}.manifest.tsv"
    [[ -f "$manifest" ]] || rto_fail_stage "manifest がありません: $(basename "$manifest")"
    RTO_BACKUP="$(basename "$dump")"
    RTO_BACKUP_AGE_MIN="$(( ($(date +%s) - $(stat -c %Y "$dump")) / 60 ))"
  fi
  # pg のクライアントが揃っていること（無ければ ops_pg_bin が止める）
  ops_pg_bin createdb >/dev/null
  ops_pg_bin pg_restore >/dev/null
  ops_pg_bin dropdb >/dev/null
  ops_pg_bin psql >/dev/null
  rto_stage_end true "release=$RTO_COMMIT backup=$RTO_BACKUP（${RTO_BACKUP_AGE_MIN} 分前）temp_db=$RTO_DB port=$RTO_PORT"

  if [[ "$dry_run" == 1 ]]; then
    log "[dry-run] 計画: fetch（${source_kind}）→ restore（$RTO_DB）→ verify（manifest・db.ts verify）→ api（127.0.0.1:$RTO_PORT の /healthz）→ 切替判断 → cleanup（停止・DROP $RTO_DB）"
    log "[dry-run] R2 取得・DB 作成・API 起動はしていません。レポートファイルも書きません"
    RTO_DECISION="dry-run（計画のみ。前提 OK）"
    RTO_RESULT=ok
    exit 0
  fi

  # ───── 3. R2 から取得 ─────
  if [[ "$source_kind" == r2 ]]; then
    rto_stage_begin fetch "R2 から dump と manifest を取得（SHA-256・サイズ照合）"
    dump="$(rto_fetch_object "$wrangler" "$bucket" "$dump_key" "$dump_size" "$dump_sha")" || rto_fail_stage "dump の取得または照合に失敗しました"
    manifest="$(rto_fetch_object "$wrangler" "$bucket" "$manifest_key" "$manifest_size" "$manifest_sha")" || rto_fail_stage "manifest の取得または照合に失敗しました"
    rto_stage_end true "bucket=$bucket dump=$RTO_BACKUP sha256=${dump_sha:0:12}"
  else
    rto_stage_begin fetch "ローカルの dump を使用（R2 取得なし）"
    rto_stage_end true "local dump=$RTO_BACKUP"
  fi

  # ───── 4. 復元 ─────
  rto_stage_begin restore "一時DBへ復元（$RTO_DB）"
  rto_db_name_ok "$RTO_DB" "$source_db" || rto_fail_stage "一時DB名の検査に失敗しました"
  # 名前が衝突して createdb が失敗した場合は、自分で作っていないので消さない
  "$(ops_pg_bin createdb)" --maintenance-db=postgres --template=template0 --encoding=UTF8 "$RTO_DB" ||
    rto_fail_stage "一時DBを作成できません"
  RTO_CREATED=1
  "$(ops_pg_bin pg_restore)" --exit-on-error --no-owner --no-privileges -d "$RTO_DB" "$dump" ||
    rto_fail_stage "pg_restore に失敗しました"
  rto_stage_end true "pg_restore OK"

  # ───── 5. 検証 ─────
  rto_stage_begin verify "検証（manifest 照合・db.ts verify）"
  ops_table_counts "$RTO_DB" >"$RTO_WORK/restored.tsv" || rto_fail_stage "復元先の件数を取得できません"
  if ! diff -u "$manifest" "$RTO_WORK/restored.tsv"; then
    rto_fail_stage "件数または監査ログ末尾のハッシュが manifest と一致しません"
  fi
  local rto_url tsx_bin
  rto_url="$(node "$OPS_DIR/pg-env.mjs" --url-for-db "$RTO_DB")" || rto_fail_stage "一時DBの接続先を作れません"
  tsx_bin="$release_dir/node_modules/.bin/tsx"
  [[ -x "$tsx_bin" ]] || tsx_bin="$OPS_ROOT/node_modules/.bin/tsx"
  [[ -x "$tsx_bin" ]] || rto_fail_stage "tsx が見つかりません（current リリースまたは実行元の node_modules）"
  (
    cd "$release_dir"
    unset MIRAI_SF_CONFIG_FILE MIGRATION_DATABASE_URL TEST_DATABASE_URL TEST_MIGRATION_DATABASE_URL
    # argv に載せない（ps で見えるため。環境変数として子だけに渡す）
    DATABASE_URL="$rto_url" "$tsx_bin" scripts/db.ts verify
  ) || rto_fail_stage "db:verify（監査ログのハッシュ連鎖を含む）に失敗しました"
  rto_stage_end true "manifest 一致（$(grep -vc '^#' "$RTO_WORK/restored.tsv") テーブル）・db.ts verify OK"

  # ───── 6. 一時 API ─────
  rto_stage_begin api "current リリースの API を一時DB・127.0.0.1:$RTO_PORT で起動し /healthz を確認"
  mkdir -p "$RTO_WORK/mail-outbox"
  (
    cd "$release_dir"
    unset MIRAI_SF_CONFIG_FILE MIGRATION_DATABASE_URL TEST_DATABASE_URL TEST_MIGRATION_DATABASE_URL
    # prod.conf の値より優先して上書きする（一時DB・一時ポート・ローカルのみ・メール送信なし）
    DATABASE_URL="$rto_url" PORT="$RTO_PORT" HOST=127.0.0.1 MAIL_MODE=off \
      MAIL_OUTBOX_DIR="$RTO_WORK/mail-outbox" COMMIT_SHA="$RTO_COMMIT" \
      exec node dist/api/server.js
  ) >"$RTO_WORK/api.log" 2>&1 9>&- &
  RTO_API_PID=$!
  local deadline=$((SECONDS + health_timeout)) healthy=0 tries=0
  while ((SECONDS < deadline)); do
    tries=$((tries + 1))
    if ! kill -0 "$RTO_API_PID" 2>/dev/null; then
      RTO_API_PID=""
      rto_fail_stage "一時 API が終了しました（起動ログは秘密を含み得るため表示しません）"
    fi
    if rto_health_ok "$RTO_PORT" "$RTO_COMMIT"; then
      healthy=1
      break
    fi
    sleep 0.5
  done
  [[ "$healthy" == 1 ]] || rto_fail_stage "/healthz が ${health_timeout} 秒以内に status=ok・db.ok=true・commit 一致になりません"
  rto_stage_end true "/healthz OK（status=ok db.ok=true commit=$RTO_COMMIT、試行 ${tries} 回）"

  # ───── 7. 切替判断 ─────
  rto_stage_begin switch_decision "切替判断（判断の記録だけ。本番の切替はしない）"
  rto_tick
  local elapsed_s=$(((RTO_NOW - RTO_STARTED_MS) / 1000))
  RTO_DECISION="切替可能（復元・検証・API 起動が成功。本番の切替・DNS・Access は未実施）"
  rto_stage_end true "宣言から ${elapsed_s} 秒で切替判断（目標 ${RTO_TARGET_MIN} 分）"
  RTO_RESULT=ok
  exit 0
}

rto_stage_begin() {
  RTO_STAGE="$1"
  RTO_STAGE_LABEL="$2"
  rto_tick
  RTO_STAGE_START="$RTO_NOW"
  log "[$1] 開始: $2"
}

rto_stage_end() { # <ok: true|false> <note>
  local end
  rto_tick
  end="$RTO_NOW"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$RTO_STAGE" "$RTO_STAGE_LABEL" "$RTO_STAGE_START" "$end" "$1" "$2" >>"$RTO_WORK/stages.tsv"
  log "[$RTO_STAGE] 終了（$(((end - RTO_STAGE_START) / 1000)) 秒）: $2"
  RTO_STAGE=""
}

rto_fail_stage() {
  rto_stage_end false "$1"
  die "$1"
}

rto_port_in_use() {
  node -e '
    const s = require("node:net").connect({ host: "127.0.0.1", port: Number(process.argv[1]) });
    s.on("connect", () => { s.destroy(); process.exit(0); });
    s.on("error", () => process.exit(1));
    setTimeout(() => process.exit(1), 2000);
  ' "$1"
}

# 一時 API の /healthz。status=ok・db.ok=true・commit 一致・environment=production をすべて必須にする
# （別アプリや Staging 設定の API を誤って「復旧できた」と判定しない）。
# 一時 API は 127.0.0.1 だけなので、環境の HTTP(S)_PROXY / ALL_PROXY を経由させない（--noproxy '*'）。
rto_health_ok() { # <port> <commit>
  local body
  body="$(curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$1/healthz" 2>/dev/null)" || return 1
  EXPECT_SHA="$2" node -e '
    const h = JSON.parse(process.argv[1]);
    const ok = h.status === "ok" && h.db && h.db.ok === true && h.commit === process.env.EXPECT_SHA &&
      h.environment === "production";
    process.exit(ok ? 0 : 1);
  ' "$body" 2>/dev/null
}

rto_resolve_wrangler() {
  local dir candidate
  if [[ -n "${MIRAI_SF_WRANGLER:-}" ]]; then
    [[ -x "$MIRAI_SF_WRANGLER" ]] && { printf '%s' "$MIRAI_SF_WRANGLER"; return 0; }
    return 1
  fi
  candidate="$(command -v wrangler 2>/dev/null || true)"
  [[ -z "$candidate" ]] || { printf '%s' "$candidate"; return 0; }
  for dir in "$HOME"/.nvm/versions/node/*/bin; do
    [[ -x "$dir/wrangler" ]] && candidate="$dir/wrangler"
  done
  [[ -n "$candidate" ]] || return 1
  printf '%s' "$candidate"
}

# R2 から 1 オブジェクトを取得し、サイズと SHA-256 を照合する。成功したら保存先のパスを出力する。
rto_fetch_object() { # <wrangler> <bucket> <key> <size> <sha256>
  local dest got_size got_sha rc=0
  dest="$RTO_WORK/$(basename "$3")"
  # systemd ユーザー環境の期限切れトークンが OAuth より優先されないよう、明示許可が無ければ外す
  if [[ -n "${MIRAI_SF_R2_API_TOKEN:-}" ]]; then
    "$1" r2 object get "$2/$3" --remote --file "$dest" >"$RTO_WORK/wrangler.log" 2>&1 || rc=$?
  else
    env -u CLOUDFLARE_API_TOKEN "$1" r2 object get "$2/$3" --remote --file "$dest" >"$RTO_WORK/wrangler.log" 2>&1 || rc=$?
  fi
  if [[ "$rc" != 0 ]]; then
    log "wrangler が終了コード $rc で失敗しました（出力本文は表示しません）: $(basename "$3")"
    return 1
  fi
  [[ -f "$dest" ]] || return 1
  got_size="$(stat -c %s "$dest")"
  got_sha="$(sha256sum "$dest" | cut -d' ' -f1)"
  if [[ "$got_size" != "$4" ]]; then
    log "サイズ不一致: $(basename "$3") got=$got_size want=$4"
    return 1
  fi
  if [[ "$got_sha" != "$5" ]]; then
    log "SHA-256 不一致: $(basename "$3")"
    return 1
  fi
  printf '%s' "$dest"
}

rto_stop_api() {
  [[ -n "${RTO_API_PID:-}" ]] || return 0
  if kill -0 "$RTO_API_PID" 2>/dev/null; then
    kill -TERM "$RTO_API_PID" 2>/dev/null || true
    local i
    for ((i = 0; i < 20; i++)); do
      kill -0 "$RTO_API_PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$RTO_API_PID" 2>/dev/null; then
      kill -KILL "$RTO_API_PID" 2>/dev/null || true
      log "一時 API が SIGTERM で止まらないため SIGKILL しました"
    fi
  fi
  wait "$RTO_API_PID" 2>/dev/null || true
  RTO_API_PID=""
}

# EXIT trap: 中断した段階の記録 → 停止・一時DB削除（cleanup 段階）→ JSON 出力 → 作業領域の削除
rto_finish() {
  local code=$?
  trap - EXIT INT TERM
  [[ -z "${RTO_STAGE:-}" ]] || rto_stage_end false "中断（終了コード $code）"
  [[ "$code" == 0 ]] || RTO_RESULT=failed

  if [[ "$RTO_MODE" == run ]]; then
    RTO_STAGE=cleanup
    RTO_STAGE_LABEL="一時 API の停止・一時DBの削除"
    rto_tick
    RTO_STAGE_START="$RTO_NOW"
    rto_stop_api
    local cleanup_ok=true cleanup_note="一時 API なし"
    if [[ "$RTO_CREATED" == 1 ]]; then
      if rto_db_name_ok "$RTO_DB" "$RTO_SOURCE_DB" &&
        "$(ops_pg_bin dropdb)" --maintenance-db=postgres --if-exists --force "$RTO_DB"; then
        cleanup_note="一時 API を停止し、一時DBを削除: $RTO_DB"
      else
        cleanup_ok=false
        cleanup_note="一時DBを削除できませんでした（手動で dropdb）: $RTO_DB"
        RTO_TEMP_DB_LEFT=1
        RTO_RESULT=failed
        code=2
      fi
    else
      cleanup_note="一時 API を停止（一時DBは未作成）"
    fi
    rto_stage_end "$cleanup_ok" "$cleanup_note"
  fi

  # レポートの保存（実行モードだけ）。保存は任意: 失敗しても終了コードは変えず、
  # JSON の reportSaved=false と標準エラーの注意で示す（標準出力の JSON が正本）。
  local finished json report_file="" report_saved=null
  rto_tick
  finished="$RTO_NOW"
  if [[ "$RTO_MODE" == run ]]; then
    report_file="$RTO_REPORT_DIR/rto-drill-$(date -u +%Y%m%dT%H%M%SZ).json"
    report_saved=false
    if mkdir -p "$RTO_REPORT_DIR" 2>/dev/null && [[ -d "$RTO_REPORT_DIR" && ! -L "$report_file" ]] &&
      (umask 077 && : >"$report_file") 2>/dev/null && chmod 600 "$report_file" 2>/dev/null; then
      report_saved=true
    fi
  fi
  json="$(rto_report_json "$finished" "$report_saved")" ||
    json='{"version":1,"kind":"mirai-sf-rto-drill","result":"failed","reportSaved":false,"error":"レポートを作れません"}'
  if [[ "$report_saved" == true ]]; then
    if printf '%s\n' "$json" >"$report_file" 2>/dev/null; then
      log "レポート: $report_file"
    else
      rm -f -- "$report_file"
      json="$(rto_report_json "$finished" false)" || true
      report_saved=false
    fi
  fi
  [[ "$report_saved" != false ]] || log "注意: レポートを保存できません（$RTO_REPORT_DIR）。標準出力の JSON を控えてください（reportSaved=false）"

  printf '%s\n' "$json" >&3
  rm -rf -- "$RTO_WORK"
  log "RTO 訓練 終了: result=$RTO_RESULT exit=$code"
  exit "$code"
}

# レポートの JSON を標準出力へ出す。引数: <終了時刻 ms> <reportSaved: true|false|null>
rto_report_json() {
  RTO_MODE="$RTO_MODE" RTO_SOURCE="$RTO_SOURCE" RTO_RESULT="$RTO_RESULT" RTO_DECISION="$RTO_DECISION" \
    RTO_STARTED_MS="$RTO_STARTED_MS" RTO_FINISHED_MS="$1" RTO_TARGET_MIN="$RTO_TARGET_MIN" \
    RTO_DB="$RTO_DB" RTO_PORT="$RTO_PORT" RTO_BACKUP="$RTO_BACKUP" RTO_BACKUP_AGE_MIN="$RTO_BACKUP_AGE_MIN" \
    RTO_COMMIT="$RTO_COMMIT" RTO_REPORT_SAVED="$2" RTO_DB_CREATED="$RTO_CREATED" RTO_TEMP_DB_LEFT="$RTO_TEMP_DB_LEFT" node -e '
        const fs = require("node:fs");
        const e = process.env;
        const iso = (ms) => new Date(Number(ms)).toISOString();
        const stages = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((line) => {
          const [name, label, start, end, ok, note] = line.split("\t");
          return { name, label, startedAt: iso(start), endedAt: iso(end), seconds: (Number(end) - Number(start)) / 1000, ok: ok === "true", note };
        });
        const totalSeconds = (Number(e.RTO_FINISHED_MS) - Number(e.RTO_STARTED_MS)) / 1000;
        const target = Number(e.RTO_TARGET_MIN);
        const report = {
          version: 1,
          kind: "mirai-sf-rto-drill",
          mode: e.RTO_MODE,
          source: e.RTO_SOURCE,
          result: e.RTO_RESULT,
          decision: e.RTO_DECISION || null,
          startedAt: iso(e.RTO_STARTED_MS),
          finishedAt: iso(e.RTO_FINISHED_MS),
          totalSeconds,
          targetMinutes: target,
          withinTarget: e.RTO_MODE === "run" && e.RTO_RESULT === "ok" ? totalSeconds <= target * 60 : null,
          tempDb: e.RTO_DB,
          port: Number(e.RTO_PORT) || null,
          release: { commit: e.RTO_COMMIT || null },
          backup: { file: e.RTO_BACKUP || null, ageMinutes: e.RTO_BACKUP_AGE_MIN === "" ? null : Number(e.RTO_BACKUP_AGE_MIN) },
          // 一時DBが残っていれば true（cleanup 失敗。tempDb の名前で手動 dropdb する）
          tempDbRemaining: e.RTO_MODE === "run" ? e.RTO_DB_CREATED === "1" && e.RTO_TEMP_DB_LEFT === "1" : false,
          reportSaved: e.RTO_REPORT_SAVED === "true" ? true : e.RTO_REPORT_SAVED === "false" ? false : null,
          stages,
          scope: "リハーサル。本番DB・本番サービス・DNS/Access は変更していない。検知は宣言時刻、切替は判断のみ",
        };
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      ' "$RTO_WORK/stages.tsv"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  rto_main "$@"
fi
