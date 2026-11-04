#!/usr/bin/env node
/**
 * SLO の材料を読取りだけで測る（Staging / 本番の /healthz と、systemd・journal・backup manifest の集計）。
 *
 * 目的（Q-12「数値目標」）: 応答時間・可用性・RPO の「案」ではなく「実測」を作る。
 * 本書の数値はそのまま docs/production/07-slo-and-measurement.md の証跡に使う。
 *
 * 何をするか:
 *   1. /healthz を --count 回叩き、HTTP 状態・所要 ms・本文の status / environment / db.ok /
 *      db.latencyMs / commit を集計する（p50 / p95 / p99 / max と失敗率）。
 *   2. --collect を付けたときだけ、次を足す（すべて読取り）:
 *      - systemctl --user show による unit / timer の状態と最終実行
 *      - journalctl --user による直近 --days 日の healthcheck / backup / restore-drill の成功・失敗
 *      - ~/.local/state/mirai-sf<env>/backups/<name>.manifest.tsv の一覧から RPO（最新の鮮度・間隔の最大値）
 *      - ~/.local/state/mirai-sf<env>/healthcheck.json の連続失敗・累計失敗（監視の記録）
 *
 * 何をしないか（禁止事項の担保）:
 *   - サービス・DB・Cloudflare・設定に触れない。HTTP は GET だけ。DB への書込みはしない。
 *   - 外部公開 URL（Access 保護）は叩かない。既定は 127.0.0.1 の 2 本のみ。
 *   - 秘密情報を出さない: preview.conf / prod.conf は読まない。URL は scheme://host:port/path に落とす。
 *     /healthz の本文は既知の項目だけを出す。journal は本文を出さず件数と時刻だけを出す。
 *
 * 使い方:
 *   node scripts/ops/measure-slo.mjs                       # 既定 30 回（2 URL × 30）
 *   node scripts/ops/measure-slo.mjs --count 5 --json
 *   node scripts/ops/measure-slo.mjs --count 30 --collect   # SLO 証跡用（journal は直近 7 日）
 *
 * 終了コード: 0=計測できた（失敗率 0）/ 1=計測失敗（引数不正・1 回でも失敗・1 度も成功しない）
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_HEALTH_URLS = ['http://127.0.0.1:8782/healthz', 'http://127.0.0.1:8783/healthz'];
const HTTP_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 10000;
/** journalctl は journal 全体を走査するため少し長めに取る。 */
const JOURNAL_TIMEOUT_MS = 60000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
/** 応答の値を出す前に形を検証する（改行などで出力・journal を汚さない）。 */
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
const MAX_COUNT = 500;
const MAX_INTERVAL_MS = 60000;
const MAX_DAYS = 90;
/** RPO の暫定目標（案）。docs/production/07-slo-and-measurement.md と揃える。 */
const RPO_TARGET_MINUTES = 60;

/** 集計する unit（既定の並び。存在しない unit は loadState=not-found として出す）。 */
const ENVIRONMENTS = [
  {
    name: 'staging',
    home: '~/.local/share/mirai-sf',
    services: [
      'mirai-sf-api.service',
      'mirai-sf-healthcheck.service',
      'mirai-sf-backup.service',
      'mirai-sf-restore-drill.service',
      'mirai-sf-autofollow.service',
      'mirai-sf-reminders.service',
      'mirai-sf-worker.service',
    ],
  },
  {
    name: 'production',
    home: '~/.local/share/mirai-sf-prod',
    services: [
      'mirai-sf-prod-api.service',
      'mirai-sf-prod-healthcheck.service',
      'mirai-sf-prod-backup.service',
      'mirai-sf-prod-restore-drill.service',
    ],
  },
];

const TIMER_UNITS = [
  'mirai-sf-healthcheck.timer',
  'mirai-sf-backup.timer',
  'mirai-sf-restore-drill.timer',
  'mirai-sf-autofollow.timer',
  'mirai-sf-reminders.timer',
  'mirai-sf-prod-healthcheck.timer',
  'mirai-sf-prod-backup.timer',
  'mirai-sf-prod-restore-drill.timer',
];

/**
 * journal の 1 行から「成功／失敗」を数える規則（unit 名 = systemd の識別子）。
 * 本文は出力しないので、ここで数えるだけにする。
 *   - healthcheck.mjs は成功で "healthcheck OK"、失敗で "healthcheck NG" を 1 回だけ出す
 *   - *.sh は成功で "backup OK" / "drill OK"、失敗で die の "エラー: " を出す
 *   - backup.sh のオフサイト送信失敗は WARN を出して終了コード 4（unit は failed）
 *   - staging-autofollow.sh は最後に "autofollow 終了: action=... exit=N" を 1 回だけ出す
 */
const JOURNAL_RULES = new Map(
  Object.entries({
    'mirai-sf-healthcheck': { success: /healthcheck OK/, failure: /healthcheck NG/ },
    'mirai-sf-prod-healthcheck': { success: /healthcheck OK/, failure: /healthcheck NG/ },
    'mirai-sf-backup': { success: /backup OK/, failure: /(エラー: |WARN オフサイトの送信に失敗)/ },
    'mirai-sf-prod-backup': { success: /backup OK/, failure: /(エラー: |WARN オフサイトの送信に失敗)/ },
    'mirai-sf-restore-drill': { success: /drill OK/, failure: /エラー: / },
    'mirai-sf-prod-restore-drill': { success: /drill OK/, failure: /エラー: / },
    'mirai-sf-autofollow': {
      success: /autofollow 終了: action=\S+ exit=0/,
      failure: /autofollow 終了: action=\S+ exit=[1-9]/,
    },
    'mirai-sf-reminders': { success: /完了|OK/, failure: /エラー: / },
  }),
);

const round = (value, digits = 3) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const timestamp = () => new Date().toISOString();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// URL は scheme://host:port/path だけにする（資格情報・クエリ・フラグメントを出さない）
function describeUrl(raw) {
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '(URL を解釈できません)';
  }
}

// 応答の値を出す前に形を検証する
function safeValue(value) {
  return typeof value === 'string' && SAFE_VALUE_PATTERN.test(value) ? value : '(想定外の値)';
}

// ネットワーク例外の文言は URL を含むことがあるので、安全な断片だけを出す
function describeFetchError(error) {
  if (error instanceof Error && error.name === 'TimeoutError') return `タイムアウト（${HTTP_TIMEOUT_MS}ms）`;
  const cause = error && typeof error === 'object' ? error.cause : undefined;
  if (cause && typeof cause === 'object') {
    if (typeof cause.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(cause.code)) return cause.code;
    if (typeof cause.errno === 'string' && /^[A-Z0-9_]{2,40}$/.test(cause.errno)) return cause.errno;
    if (cause.message === 'bad port') return 'bad port';
  }
  return error instanceof Error ? error.name : '不明なエラー';
}

/** ローカルのホーム配下のパスを ~ に縮める（利用者名を出さない）。 */
function shortenPath(path) {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

/** 標本から p50 / p95 / p99 / max を出す（nearest-rank。標本が少ないときは max に寄る）。 */
function latencyStats(values) {
  if (values.length === 0) return { n: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n: sorted.length,
    min: round(sorted[0]),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sum / sorted.length),
  };
}

function countValues(items, pick) {
  const counts = new Map();
  for (const item of items) {
    const key = pick(item);
    if (key === null || key === undefined) continue;
    const label = String(key);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

class UsageError extends Error {}

function parseInteger(name, raw, min, max) {
  if (!/^-?\d+$/.test(raw)) throw new UsageError(`${name} は整数で指定してください: ${raw}`);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`${name} は ${min}〜${max} の範囲で指定してください: ${raw}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = { urls: [], count: 30, intervalMs: 200, days: 7, json: false, collect: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const separator = arg.indexOf('=');
    const name = separator === -1 ? arg : arg.slice(0, separator);
    const inline = separator === -1 ? null : arg.slice(separator + 1);
    const takeValue = () => {
      if (inline !== null) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${name} には値が必要です`);
      index += 1;
      return next;
    };
    switch (name) {
      case '--health-url':
        options.urls.push(takeValue());
        break;
      case '--count':
        options.count = parseInteger(name, takeValue(), 1, MAX_COUNT);
        break;
      case '--interval-ms':
        options.intervalMs = parseInteger(name, takeValue(), 0, MAX_INTERVAL_MS);
        break;
      case '--days':
        options.days = parseInteger(name, takeValue(), 1, MAX_DAYS);
        break;
      case '--json':
        options.json = true;
        break;
      case '--collect':
        options.collect = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new UsageError(`不明なオプション: ${arg}`);
    }
  }

  if (options.help) return options;
  if (options.urls.length === 0) options.urls = [...DEFAULT_HEALTH_URLS];
  for (const url of options.urls) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      // 値そのものは出さない（資格情報を含む URL を渡されたときに備える）
      throw new UsageError('--health-url を URL として解釈できません');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new UsageError('--health-url は http / https だけを指定できます');
    }
    if (parsed.username || parsed.password) {
      throw new UsageError('--health-url に資格情報は指定できません（秘密を argv に載せない）');
    }
  }
  return options;
}

function printUsage() {
  process.stdout.write(
    [
      '使い方: node scripts/ops/measure-slo.mjs [オプション]',
      '',
      '  --health-url <url>   計測する /healthz（複数可。既定: 8782=Staging, 8783=本番 の 2 本）',
      '  --count <n>          各 URL の試行回数（既定 30、1〜500）',
      '  --interval-ms <n>    試行の間隔 ms（既定 200、0〜60000）',
      '  --collect            systemd / journal（直近 --days 日）/ backup manifest も集計する（読取りのみ）',
      '  --days <n>           journal を遡る日数（既定 7、1〜90）',
      '  --json               結果を JSON で stdout へ出す（診断は stderr）',
      '  --help, -h           この使い方を表示する',
      '',
      '読取り専用: サービス・DB・Cloudflare・設定には触れません（HTTP は GET のみ）。',
      '外部公開 URL（Access 保護）は叩きません。秘密情報は出力しません。',
      '終了コード: 0=計測できた（失敗率 0）/ 1=計測失敗（引数不正・1 回でも失敗）',
    ].join('\n') + '\n',
  );
}

// ---------------------------------------------------------------------------
// 1. /healthz の計測
// ---------------------------------------------------------------------------

async function probeOnce(url) {
  const startedAt = performance.now();
  const at = timestamp();
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    return {
      at,
      httpStatus: null,
      durationMs: round(performance.now() - startedAt),
      ok: false,
      failure: `接続できません（${describeFetchError(error)}）`,
    };
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    return {
      at,
      httpStatus: response.status,
      durationMs: round(performance.now() - startedAt),
      ok: false,
      failure: `本文を読めません（${describeFetchError(error)}）`,
    };
  }
  const durationMs = round(performance.now() - startedAt);

  if (response.status !== 200) {
    return { at, httpStatus: response.status, durationMs, ok: false, failure: `HTTP ${response.status}（200 を期待）` };
  }

  let health;
  try {
    health = JSON.parse(text);
  } catch {
    return { at, httpStatus: response.status, durationMs, ok: false, failure: '本文が JSON ではありません' };
  }
  if (!health || typeof health !== 'object') {
    return { at, httpStatus: response.status, durationMs, ok: false, failure: '本文が JSON オブジェクトではありません' };
  }

  const db = health.db && typeof health.db === 'object' ? health.db : null;
  const dbOk = db ? db.ok === true : false;
  const dbLatencyMs =
    db && typeof db.latencyMs === 'number' && Number.isFinite(db.latencyMs) && db.latencyMs >= 0 ? round(db.latencyMs, 3) : null;
  const status = safeValue(health.status);
  const environment = safeValue(health.environment);
  const commit = SHA_PATTERN.test(String(health.commit)) ? String(health.commit) : null;

  const failures = [];
  if (status !== 'ok') failures.push(`status=${status}（ok を期待）`);
  if (!dbOk) failures.push('db.ok=true ではありません');

  return {
    at,
    httpStatus: response.status,
    durationMs,
    ok: failures.length === 0,
    failure: failures.length === 0 ? null : failures.join(' / '),
    status,
    environment,
    app: safeValue(health.app),
    version: safeValue(health.version),
    commit,
    dbOk,
    dbLatencyMs,
  };
}

function summarizeTarget(url, probes) {
  const succeeded = probes.filter((probe) => probe.ok);
  const failed = probes.length - succeeded.length;
  return {
    url: describeUrl(url),
    attempts: probes.length,
    succeeded: succeeded.length,
    failed,
    failureRate: probes.length === 0 ? null : round(failed / probes.length, 4),
    httpStatus: countValues(probes, (probe) => probe.httpStatus),
    status: countValues(succeeded, (probe) => probe.status),
    environment: countValues(succeeded, (probe) => probe.environment),
    commits: Object.entries(countValues(succeeded, (probe) => probe.commit)).map(([commit, count]) => ({
      commit,
      count,
    })),
    latencyMs: latencyStats(succeeded.map((probe) => probe.durationMs)),
    dbLatencyMs: latencyStats(succeeded.map((probe) => probe.dbLatencyMs).filter((value) => value !== null)),
    firstAt: probes.length > 0 ? probes[0].at : null,
    lastAt: probes.length > 0 ? probes[probes.length - 1].at : null,
    failures: probes
      .filter((probe) => !probe.ok)
      .slice(0, 20)
      .map((probe) => ({ at: probe.at, httpStatus: probe.httpStatus, reason: probe.failure })),
  };
}

async function runProbes(options) {
  const startedAt = timestamp();
  const targets = [];
  for (const url of options.urls) {
    const probes = [];
    for (let attempt = 0; attempt < options.count; attempt += 1) {
      probes.push(await probeOnce(url));
      if (attempt < options.count - 1 && options.intervalMs > 0) await sleep(options.intervalMs);
    }
    targets.push(summarizeTarget(url, probes));
  }
  return { startedAt, finishedAt: timestamp(), count: options.count, intervalMs: options.intervalMs, targets };
}

// ---------------------------------------------------------------------------
// 2. 収集（--collect）: systemd / journal / backup manifest / 監視の状態ファイル
// ---------------------------------------------------------------------------

function describeCommandFailure(error) {
  const code = error && typeof error.code === 'number' ? error.code : null;
  const stderr = error && typeof error.stderr === 'string' ? error.stderr : '';
  const first = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0];
  // コマンドの stderr はパスや URL を含みうるので 1 行・160 文字までに切る
  const cleaned = (first ?? '')
    .replace(/[\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
  return `終了コード ${code ?? '不明'}${cleaned ? `: ${cleaned}` : ''}`;
}

/** 外部コマンドを実行する（読取りのための補助。失敗は例外にせず理由を返す）。 */
function runCommand(command, args, timeoutMs) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, reason: describeCommandFailure(error) };
  }
}

function parseKeyValue(text) {
  const properties = {};
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return properties;
}

/** systemd の時刻表示から曜日を落とす（"Wed 2026-11-04 15:25:00 JST" → "2026-11-04 15:25:00 JST"）。 */
function formatSystemdTime(raw) {
  if (!raw) return '-';
  const trimmed = String(raw).trim();
  if (trimmed === '' || trimmed === 'n/a') return '-';
  return trimmed.replace(/^[A-Z][a-z]{2}\s+/, '');
}

function showService(unit) {
  const result = runCommand(
    'systemctl',
    [
      '--user',
      'show',
      '-p',
      'LoadState',
      '-p',
      'ActiveState',
      '-p',
      'SubState',
      '-p',
      'UnitFileState',
      '-p',
      'Result',
      '-p',
      'ExecMainStatus',
      '-p',
      'ExecMainExitTimestamp',
      '-p',
      'ExecMainStartTimestampMonotonic',
      '-p',
      'ExecMainExitTimestampMonotonic',
      '-p',
      'NRestarts',
      unit,
    ],
    COMMAND_TIMEOUT_MS,
  );
  if (!result.ok) return { unit, error: result.reason };
  const properties = parseKeyValue(result.stdout);
  // 実行時間は monotonic の差分で出す（時刻文字列の TZ 解釈に依存しない）
  const startMonotonic = Number(properties.ExecMainStartTimestampMonotonic ?? 0);
  const exitMonotonic = Number(properties.ExecMainExitTimestampMonotonic ?? 0);
  const execMainDurationSeconds =
    startMonotonic > 0 && exitMonotonic > startMonotonic ? round((exitMonotonic - startMonotonic) / 1e6, 1) : null;
  return {
    unit,
    loadState: properties.LoadState ?? null,
    activeState: properties.ActiveState ?? null,
    subState: properties.SubState ?? null,
    unitFileState: properties.UnitFileState ?? null,
    result: properties.Result ?? null,
    execMainStatus: properties.ExecMainStatus ?? null,
    execMainExitAt: properties.ExecMainExitTimestamp ? formatSystemdTime(properties.ExecMainExitTimestamp) : null,
    execMainDurationSeconds,
    nRestarts: properties.NRestarts ?? null,
  };
}

function showTimer(unit) {
  const result = runCommand(
    'systemctl',
    [
      '--user',
      'show',
      '-p',
      'LoadState',
      '-p',
      'ActiveState',
      '-p',
      'NextElapseUSecRealtime',
      '-p',
      'LastTriggerUSec',
      '-p',
      'Unit',
      unit,
    ],
    COMMAND_TIMEOUT_MS,
  );
  if (!result.ok) return { unit, error: result.reason };
  const properties = parseKeyValue(result.stdout);
  return {
    unit,
    loadState: properties.LoadState ?? null,
    activeState: properties.ActiveState ?? null,
    activates: properties.Unit ?? null,
    nextRunAt: properties.NextElapseUSecRealtime ? formatSystemdTime(properties.NextElapseUSecRealtime) : null,
    lastTriggerAt: properties.LastTriggerUSec ? formatSystemdTime(properties.LastTriggerUSec) : null,
  };
}

function collectSystemd() {
  const services = [];
  for (const environment of ENVIRONMENTS) {
    for (const service of environment.services) services.push({ environment: environment.name, ...showService(service) });
  }
  const timers = TIMER_UNITS.map((unit) => showTimer(unit));
  return {
    collectedAt: timestamp(),
    services,
    timers,
    // systemd 全体が使えない場合（user manager が無い等）の理由を 1 つにまとめる
    systemdAvailable: services.every((service) => !service.error),
    errors: services.filter((service) => service.error).map((service) => `${service.unit}: ${service.error}`),
  };
}

/**
 * journal を読む（unit ごとに 1 回だけ journalctl を呼ぶ）。
 *
 * 注意: systemd の ExecStart が `env ...` の unit（backup / drill 等）では、アプリのログが
 * 識別子 `env` で記録される。そのため 1 回のまとめ呼び出しで識別子から unit を判定すると
 * 取りこぼす。-u を 1 unit ずつ指定して、その unit の cgroup に属する行だけを数える。
 * 読めない・該当が無い場合は理由を返して継続する（計測全体は止めない）。
 * 出力は件数と時刻だけ（本文は出さない）。
 */
function collectJournal(days) {
  const units = ENVIRONMENTS.flatMap((environment) => environment.services.map((service) => service.replace(/\.service$/, '')));
  const perUnit = {};
  const errors = [];
  let windowFirst = null;
  let windowLast = null;
  let totalEntries = 0;

  for (const unit of units) {
    const result = runCommand(
      'journalctl',
      ['--user', '-u', unit, '--since', `${days} days ago`, '--no-pager', '-o', 'short-iso'],
      JOURNAL_TIMEOUT_MS,
    );
    const entry = {
      entries: 0,
      firstAt: null,
      lastAt: null,
      successCount: 0,
      failureCount: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      hasRules: false,
    };
    if (!result.ok) {
      errors.push(`${unit}: ${result.reason}`);
      perUnit[unit] = { ...entry, error: result.reason };
      continue;
    }

    const rules = JOURNAL_RULES.get(unit) ?? null;
    entry.hasRules = rules !== null;
    for (const line of result.stdout.split('\n')) {
      if (line.trim() === '') continue;
      const matched = /^(\d{4}-\d{2}-\d{2}T\S+)\s+\S+\s+(.*)$/.exec(line);
      if (!matched) continue;
      const at = matched[1];
      const rest = matched[2];
      const colon = rest.indexOf(': ');
      const message = colon === -1 ? rest : rest.slice(colon + 2);

      entry.entries += 1;
      totalEntries += 1;
      if (entry.firstAt === null || at < entry.firstAt) entry.firstAt = at;
      if (entry.lastAt === null || at > entry.lastAt) entry.lastAt = at;
      if (windowFirst === null || at < windowFirst) windowFirst = at;
      if (windowLast === null || at > windowLast) windowLast = at;

      if (rules && rules.success.test(message)) {
        entry.successCount += 1;
        if (entry.lastSuccessAt === null || at > entry.lastSuccessAt) entry.lastSuccessAt = at;
      }
      if (rules && rules.failure.test(message)) {
        entry.failureCount += 1;
        if (entry.lastFailureAt === null || at > entry.lastFailureAt) entry.lastFailureAt = at;
      }
    }
    perUnit[unit] = entry;
  }

  const requestedSinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const windowFirstMs = windowFirst === null ? null : Date.parse(windowFirst);
  // journal のローテートにより、要求した期間を覆えていないことがある（隠さずに出す）
  const coversRequestedWindow = windowFirstMs !== null && windowFirstMs <= requestedSinceMs + 5 * 60 * 1000;

  return {
    ok: errors.length < units.length,
    requestedDays: days,
    requestedSince: new Date(requestedSinceMs).toISOString(),
    windowFirst,
    windowLast,
    totalEntries,
    coversRequestedWindow,
    units: perUnit,
    errors,
    unitsWithoutEntries: units.filter((unit) => (perUnit[unit]?.entries ?? 0) === 0),
  };
}

/** バックアップのファイル名に埋まった UTC 時刻（mirai_sf_prod-20261104T050500Z.dump）。 */
const BACKUP_STAMP = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.manifest\.tsv$/;

function parseBackupStamp(name) {
  const matched = BACKUP_STAMP.exec(name);
  if (!matched) return null;
  const [, year, month, day, hour, minute, second] = matched;
  const at = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isFinite(at) ? at : null;
}

function newestFile(dir, names) {
  let newest = null;
  for (const name of names) {
    let stats;
    try {
      stats = statSync(join(dir, name));
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    if (newest === null || stats.mtimeMs > newest.mtimeMs) newest = { name, mtimeMs: stats.mtimeMs };
  }
  if (newest === null) return null;
  return {
    name: newest.name,
    at: new Date(newest.mtimeMs).toISOString(),
    ageMinutes: round((Date.now() - newest.mtimeMs) / 60000, 1),
  };
}

function summarizeBackupDir(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    return { dir: shortenPath(dir), error: `読めません（${error instanceof Error ? error.name : '不明'}）` };
  }
  const manifests = names.filter((name) => name.endsWith('.manifest.tsv'));
  const dumps = names.filter((name) => name.endsWith('.dump'));
  const offsiteRecords = names.filter((name) => name.endsWith('.r2.json'));

  const stamps = manifests
    .map((name) => ({ name, at: parseBackupStamp(name) }))
    .filter((entry) => entry.at !== null)
    .sort((a, b) => a.at - b.at);

  const gaps = [];
  for (let index = 1; index < stamps.length; index += 1) {
    gaps.push({
      minutes: round((stamps[index].at - stamps[index - 1].at) / 60000, 1),
      from: new Date(stamps[index - 1].at).toISOString(),
      to: new Date(stamps[index].at).toISOString(),
    });
  }
  const maxGap = gaps.reduce((worst, gap) => (worst === null || gap.minutes > worst.minutes ? gap : worst), null);
  const overRpo = gaps.filter((gap) => gap.minutes > RPO_TARGET_MINUTES);
  const meanGap = gaps.length === 0 ? null : round(gaps.reduce((total, gap) => total + gap.minutes, 0) / gaps.length, 1);

  const newestDump = newestFile(dir, dumps);
  return {
    dir: shortenPath(dir),
    manifestCount: manifests.length,
    dumpCount: dumps.length,
    offsiteRecordCount: offsiteRecords.length,
    oldestAt: stamps.length > 0 ? new Date(stamps[0].at).toISOString() : null,
    newestAt: stamps.length > 0 ? new Date(stamps[stamps.length - 1].at).toISOString() : null,
    spanHours:
      stamps.length > 1 ? round((stamps[stamps.length - 1].at - stamps[0].at) / 3600000, 1) : stamps.length === 1 ? 0 : null,
    newestDump,
    newestManifest: newestFile(dir, manifests),
    maxGapMinutes: maxGap ? maxGap.minutes : null,
    maxGapFrom: maxGap ? maxGap.from : null,
    maxGapTo: maxGap ? maxGap.to : null,
    meanGapMinutes: meanGap,
    gapsOverRpo: overRpo.length,
    gapsOverRpoSample: overRpo.slice(0, 5),
    // RPO（暫定 60 分）を最新の鮮度で満たすか。dump が無ければ判定しない
    rpoSatisfied: newestDump === null ? null : newestDump.ageMinutes <= RPO_TARGET_MINUTES,
    rpoTargetMinutes: RPO_TARGET_MINUTES,
  };
}

function collectBackups() {
  const stateRoot = resolve(homedir(), '.local/state');
  let entries;
  try {
    entries = readdirSync(stateRoot, { withFileTypes: true });
  } catch (error) {
    return { ok: false, reason: `状態ディレクトリを読めません（${error instanceof Error ? error.name : '不明'}）`, dirs: [] };
  }
  const dirs = [];
  const skipped = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('mirai-sf')) continue;
    const backups = join(stateRoot, entry.name, 'backups');
    if (!existsSync(backups)) {
      skipped.push(shortenPath(backups));
      continue;
    }
    try {
      dirs.push({ environment: entry.name, ...summarizeBackupDir(backups) });
    } catch (error) {
      dirs.push({ environment: entry.name, dir: shortenPath(backups), error: error instanceof Error ? error.name : '不明' });
    }
  }
  dirs.sort((a, b) => a.environment.localeCompare(b.environment));
  return { ok: true, collectedAt: timestamp(), dirs, skippedDirs: skipped };
}

/** healthcheck の状態ファイル（監視の記録）。秘密は無いが、出す項目を選ぶ。 */
function collectHealthState() {
  const stateRoot = resolve(homedir(), '.local/state');
  let entries;
  try {
    entries = readdirSync(stateRoot, { withFileTypes: true });
  } catch (error) {
    return { ok: false, reason: `状態ディレクトリを読めません（${error instanceof Error ? error.name : '不明'}）`, files: [] };
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('mirai-sf')) continue;
    const healthFile = join(stateRoot, entry.name, 'healthcheck.json');
    if (!existsSync(healthFile)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(healthFile, 'utf8'));
    } catch {
      files.push({ stateDir: entry.name, path: shortenPath(healthFile), error: 'JSON として読めません' });
      continue;
    }
    if (!parsed || typeof parsed !== 'object') {
      files.push({ stateDir: entry.name, path: shortenPath(healthFile), error: 'JSON オブジェクトではありません' });
      continue;
    }
    files.push({
      stateDir: entry.name,
      path: shortenPath(healthFile),
      checkedAt: parsed.checkedAt ?? null,
      ok: parsed.ok === true,
      consecutiveFailures: parsed.consecutiveFailures ?? null,
      totalFailures: parsed.totalFailures ?? null,
      lastFailureAt: parsed.lastFailureAt ?? null,
      environment: parsed.environment ?? null,
      dbOk: parsed.dbOk ?? null,
      healthCommit: SHA_PATTERN.test(String(parsed.healthCommit)) ? parsed.healthCommit : null,
      lastIncidentFailures: parsed.lastIncidentFailures ?? null,
      recoveredAt: parsed.recoveredAt ?? null,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.length : 0,
    });
  }
  files.sort((a, b) => a.stateDir.localeCompare(b.stateDir));
  return { ok: true, collectedAt: timestamp(), files };
}

/** autofollow の実行記録（Staging の追従が最後にどうだったか）。 */
function collectAutofollow() {
  const stateFile = resolve(homedir(), '.local/state/mirai-sf/autofollow.json');
  if (!existsSync(stateFile)) return { ok: true, path: shortenPath(stateFile), found: false };
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { ok: true, path: shortenPath(stateFile), found: false };
    return {
      ok: true,
      path: shortenPath(stateFile),
      found: true,
      at: parsed.at ?? null,
      action: safeValue(parsed.action),
      exitCode: parsed.exitCode ?? null,
      target: SHA_PATTERN.test(String(parsed.target)) ? parsed.target : null,
    };
  } catch {
    return { ok: true, path: shortenPath(stateFile), found: true, error: 'JSON として読めません' };
  }
}

function collectAll(options) {
  const collect = { collectedAt: timestamp(), days: options.days };
  const attempt = (name, fn) => {
    try {
      collect[name] = fn();
    } catch (error) {
      // 1 つの収集が失敗しても他は続ける（計測全体を止めない）
      collect[name] = { ok: false, reason: `収集に失敗しました（${error instanceof Error ? error.name : '不明'}）` };
    }
  };
  attempt('systemd', collectSystemd);
  attempt('journal', () => collectJournal(options.days));
  attempt('backups', collectBackups);
  attempt('healthState', collectHealthState);
  attempt('autofollow', collectAutofollow);
  return collect;
}

// ---------------------------------------------------------------------------
// 3. 表示
// ---------------------------------------------------------------------------

const print = (line = '') => process.stdout.write(`${line}\n`);
const printError = (line) => process.stderr.write(`${line}\n`);

function formatNumber(value, digits = 1) {
  return value === null || value === undefined ? '未測定' : Number(value).toFixed(digits);
}

/** 表示用にローカル時刻（オフセット付き）へ直す。JSON は ISO(UTC) のまま返す。 */
function formatLocal(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (value) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function formatStats(stats, digits = 1) {
  if (stats.n === 0) return '標本なし';
  return `p50=${formatNumber(stats.p50, digits)} p95=${formatNumber(stats.p95, digits)} p99=${formatNumber(
    stats.p99,
    digits,
  )} max=${formatNumber(stats.max, digits)} mean=${formatNumber(stats.mean, digits)} (n=${stats.n})`;
}

function formatCounts(counts) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return '-';
  return entries.map(([key, count]) => `${key}=${count}`).join(' ');
}

function printProbes(report) {
  print(
    `計測: ${formatLocal(report.startedAt)} → ${formatLocal(report.finishedAt)}（count=${report.count}, interval=${report.intervalMs}ms）`,
  );
  for (const target of report.targets) {
    print('');
    print(`[target] ${target.url}`);
    print(
      `  試行 ${target.attempts} / 成功 ${target.succeeded} / 失敗 ${target.failed}（失敗率 ${formatNumber(
        target.failureRate === null ? null : target.failureRate * 100,
        1,
      )}%）`,
    );
    print(`  HTTP: ${formatCounts(target.httpStatus)}`);
    print(`  応答時間(ms): ${formatStats(target.latencyMs)}`);
    print(`  db.latencyMs: ${formatStats(target.dbLatencyMs, 2)}`);
    print(`  status: ${formatCounts(target.status)} / environment: ${formatCounts(target.environment)}`);
    if (target.commits.length > 0) {
      print(`  commit: ${target.commits.map((entry) => `${entry.commit}（${entry.count} 回）`).join(' / ')}`);
    } else {
      print('  commit: 未測定（成功した応答なし）');
    }
    for (const failure of target.failures.slice(0, 5)) {
      print(`  失敗の例: ${formatLocal(failure.at)} ${failure.reason}`);
    }
  }
}

function printSystemd(systemd) {
  print('');
  print(`== systemd（${formatLocal(systemd.collectedAt)}）==`);
  if (!systemd.systemdAvailable) {
    print(`  systemd（user）を読めない unit があります: ${systemd.errors.join(' / ')}`);
  }
  print('unit                                   active/sub      result   exit  実行s   再起動 最終実行');
  for (const service of systemd.services) {
    if (service.error) {
      print(`${service.unit.padEnd(38)} 読めません（${service.error}）`);
      continue;
    }
    if (service.loadState === 'not-found') {
      print(`${service.unit.padEnd(38)} not-found`);
      continue;
    }
    const activeSub = `${service.activeState ?? '-'}/${service.subState ?? '-'}`;
    print(
      `${service.unit.padEnd(38)} ${activeSub.padEnd(14)} ${String(service.result ?? '-').padEnd(8)} ${String(
        service.execMainStatus ?? '-',
      ).padEnd(5)} ${String(service.execMainDurationSeconds === null ? '-' : service.execMainDurationSeconds).padEnd(
        7,
      )} ${String(service.nRestarts ?? '-').padEnd(6)} ${service.execMainExitAt ?? '-'}`,
    );
  }
  print('');
  print('timer                                  active    次回                    最終');
  for (const timer of systemd.timers) {
    if (timer.error) {
      print(`${timer.unit.padEnd(38)} 読めません（${timer.error}）`);
      continue;
    }
    if (timer.loadState === 'not-found') {
      print(`${timer.unit.padEnd(38)} not-found`);
      continue;
    }
    print(
      `${timer.unit.padEnd(38)} ${String(timer.activeState ?? '-').padEnd(9)} ${String(timer.nextRunAt ?? '-').padEnd(
        23,
      )} ${timer.lastTriggerAt ?? '-'}`,
    );
  }
}

function printJournal(journal) {
  print('');
  print(`== journal（直近 ${journal.requestedDays} 日）==`);
  if (!journal.ok) {
    print(`  取得できません（${(journal.errors ?? []).join(' / ') || '理由不明'}）。他の計測は継続します。`);
    return;
  }
  print(
    `  要求した期間: ${formatLocal(journal.requestedSince)} 以降 / 実際の記録: ${formatLocal(journal.windowFirst)} 〜 ${formatLocal(
      journal.windowLast,
    )}`,
  );
  if (!journal.coversRequestedWindow) {
    print('  注意: journal のローテートにより要求した期間を覆えていません（成功・失敗の回数は「記録が残っている範囲」の値）。');
  }
  print('unit                                  記録   成功  失敗  最終成功                    最終失敗');
  for (const [unit, entry] of Object.entries(journal.units)) {
    if (entry.error) {
      print(`${unit.padEnd(38)} 読めません（${entry.error}）`);
      continue;
    }
    if (entry.entries === 0) {
      print(`${unit.padEnd(38)} 0      -     -     記録なし（journal に期間内の記録がありません）`);
      continue;
    }
    const success = entry.hasRules ? entry.successCount : '-';
    const failure = entry.hasRules ? entry.failureCount : '-';
    print(
      `${unit.padEnd(38)} ${String(entry.entries).padEnd(5)} ${String(success).padEnd(5)} ${String(failure).padEnd(
        5,
      )} ${String(entry.lastSuccessAt ?? '-').padEnd(27)} ${entry.lastFailureAt ?? '-'}`,
    );
  }
}

function printBackups(backups) {
  print('');
  print(`== バックアップ manifest（RPO 暫定目標 ${RPO_TARGET_MINUTES} 分）==`);
  if (!backups.ok) {
    print(`  取得できません（${backups.reason}）`);
    return;
  }
  for (const dir of backups.dirs) {
    if (dir.error) {
      print(`  ${dir.dir}: ${dir.error}`);
      continue;
    }
    print('');
    print(`  [${dir.environment}] ${dir.dir}`);
    print(
      `    manifest ${dir.manifestCount} 件 / dump ${dir.dumpCount} 件 / オフサイト送信記録 ${dir.offsiteRecordCount} 件（${formatLocal(
        dir.oldestAt,
      )} 〜 ${formatLocal(dir.newestAt)}）`,
    );
    if (dir.newestDump) {
      print(
        `    最新 dump: ${dir.newestDump.name}（mtime ${formatLocal(dir.newestDump.at)}・${formatNumber(
          dir.newestDump.ageMinutes,
          1,
        )} 分前）`,
      );
    } else {
      print('    最新 dump: なし');
    }
    if (dir.maxGapMinutes !== null) {
      print(
        `    間隔: 最大 ${formatNumber(dir.maxGapMinutes, 1)} 分（${formatLocal(dir.maxGapFrom)} → ${formatLocal(
          dir.maxGapTo,
        )}）/ 平均 ${formatNumber(dir.meanGapMinutes, 1)} 分 / ${RPO_TARGET_MINUTES} 分超 ${dir.gapsOverRpo} 件`,
      );
    } else {
      print('    間隔: 未測定（manifest が 2 件未満）');
    }
    const freshness = dir.newestDump === null ? '未測定（dump なし）' : dir.rpoSatisfied ? '満たす' : '満たさない';
    print(`    RPO 判定（最新の鮮度）: ${freshness}`);
  }
  if (backups.skippedDirs.length > 0) print(`  backups ディレクトリ無し: ${backups.skippedDirs.join(', ')}`);
}

function printHealthState(healthState) {
  print('');
  print(`== healthcheck の記録（${formatLocal(healthState.collectedAt)}）==`);
  if (!healthState.ok) {
    print(`  取得できません（${healthState.reason}）`);
    return;
  }
  if (healthState.files.length === 0) {
    print('  healthcheck.json がありません');
  }
  for (const file of healthState.files) {
    if (file.error) {
      print(`  ${file.path}: ${file.error}`);
      continue;
    }
    print(
      `  ${file.path}  ok=${file.ok} 連続失敗=${file.consecutiveFailures ?? '-'} 累計失敗=${file.totalFailures ?? '-'} 最終失敗=${formatLocal(
        file.lastFailureAt,
      )} 最終回復=${formatLocal(file.recoveredAt)} 警告=${file.warnings}`,
    );
  }
}

function printAutofollow(autofollow) {
  print('');
  print('== autofollow（Staging の main 追従）==');
  if (!autofollow.found) {
    print(`  ${autofollow.path} がありません`);
    return;
  }
  if (autofollow.error) {
    print(`  ${autofollow.path}: ${autofollow.error}`);
    return;
  }
  print(
    `  ${formatLocal(autofollow.at)} action=${autofollow.action} exit=${autofollow.exitCode} target=${autofollow.target ?? '-'}`,
  );
}

function printHuman(report) {
  printProbes(report);
  if (report.collect) {
    printSystemd(report.collect.systemd);
    printJournal(report.collect.journal);
    printBackups(report.collect.backups);
    printHealthState(report.collect.healthState);
    printAutofollow(report.collect.autofollow);
  } else {
    print('');
    print('（systemd / journal / backup manifest の集計は --collect で有効になります）');
  }
}

// ---------------------------------------------------------------------------
// 4. 入口
// ---------------------------------------------------------------------------

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    printError(`エラー: ${error.message}`);
    printError('使い方は --help を参照してください。');
    return 1;
  }
  if (options.help) {
    printUsage();
    return 0;
  }

  const probes = await runProbes(options);
  const report = {
    version: 1,
    tool: 'scripts/ops/measure-slo.mjs',
    mode: 'read-only',
    count: probes.count,
    intervalMs: probes.intervalMs,
    startedAt: probes.startedAt,
    finishedAt: probes.finishedAt,
    targets: probes.targets,
    collect: options.collect ? collectAll(options) : null,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }

  const failedTargets = report.targets.filter((target) => target.failed > 0 || target.succeeded === 0);
  for (const target of failedTargets) {
    printError(`NG: ${target.url}（成功 ${target.succeeded}/${target.attempts}）`);
  }
  return failedTargets.length > 0 ? 1 : 0;
}

process.exitCode = await main();
