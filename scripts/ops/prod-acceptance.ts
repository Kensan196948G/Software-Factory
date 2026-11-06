#!/usr/bin/env node
/**
 * 本番リリース直後の受入を 1 コマンドで確認する（読み取り専用）。
 *
 *   tsx scripts/ops/prod-acceptance.ts <commit-sha> [--json]
 *
 * 確認する内容（すべて読み取り）:
 *   1. /healthz: HTTP 200・status=ok・environment=production・commit が対象 SHA と一致・db.ok
 *   2. /readyz: HTTP 200・status=ready
 *   3. prod-api unit: active・Result=success・NRestarts=0
 *   4. journal: unit 起動以降の 5xx が 0 件
 *   5. DB（READ ONLY）: 件数と schema_migrations の最大を記録（合否には使わない。変化の検知用）
 *   6. healthcheck の状態ファイル: ok=true・environment=production・healthCommit が対象 SHA・auth.status が misconfigured でない
 *   7. オフサイト（R2）: 直近 2 世代に r2.json があり size/SHA-256 が一致（offsite-status.ts を再利用）
 *
 * 終了コード: 0=全 PASS / 1=FAIL あり / 2=引数不正
 * 秘密・個人情報・接続文字列は出力しない（commit・件数・時刻だけ）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkOffsiteStatus } from './offsite-status.js';

export const USAGE = '使い方: tsx scripts/ops/prod-acceptance.ts <commit-sha> [--json]';

/** healthcheck の状態ファイルがこの分数より古ければ FAIL（timer は 5 分間隔）。 */
export const HEALTHCHECK_MAX_AGE_MINUTES = 20;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthzBody {
  status?: unknown;
  environment?: unknown;
  commit?: unknown;
  db?: { ok?: unknown };
  auth?: { status?: unknown };
}

export interface AcceptanceFacts {
  expectedSha: string;
  healthz: { httpStatus: number; body: HealthzBody | null; error?: string };
  readyz: { httpStatus: number; body: { status?: unknown } | null; error?: string };
  unit: { activeState: string | null; result: string | null; nRestarts: string | null; error?: string };
  fiveXxCount: number | null;
  db: { appUser: number; auditLog: number; request: number; session: number; migration: string } | null;
  dbError?: string;
  healthcheck: {
    ok: boolean;
    environment: string | null;
    healthCommit: string | null;
    authStatus: string | null;
    warnings: string[];
    checkedAt: string | null;
  } | null;
  offsite: { ok: boolean; newestAgeMinutes: number | null; problems: string[] };
}

function short(value: unknown): string {
  return value === null || value === undefined ? '-' : String(value);
}

/** 収集した事実から合否を判定する（純関数。テスト対象）。 */
export function evaluateAcceptance(facts: AcceptanceFacts): { ok: boolean; checks: CheckResult[] } {
  const checks: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  const hz = facts.healthz;
  add(
    'healthz: HTTP 200 / status=ok',
    hz.httpStatus === 200 && hz.body?.status === 'ok',
    `http=${hz.httpStatus} status=${short(hz.body?.status)}${hz.error ? ` error=${hz.error}` : ''}`,
  );
  add(
    'healthz: environment=production',
    hz.body?.environment === 'production',
    `environment=${short(hz.body?.environment)}`,
  );
  add(
    'healthz: commit が対象 SHA と一致',
    hz.body?.commit === facts.expectedSha,
    `healthz=${short(hz.body?.commit)} expected=${facts.expectedSha}`,
  );
  add('healthz: db.ok', hz.body?.db?.ok === true, `db.ok=${short(hz.body?.db?.ok)}`);

  add(
    'readyz: HTTP 200 / status=ready',
    facts.readyz.httpStatus === 200 && facts.readyz.body?.status === 'ready',
    `http=${facts.readyz.httpStatus} status=${short(facts.readyz.body?.status)}${facts.readyz.error ? ` error=${facts.readyz.error}` : ''}`,
  );

  add(
    'prod-api unit: active / success / NRestarts=0',
    facts.unit.activeState === 'active' && facts.unit.result === 'success' && facts.unit.nRestarts === '0',
    `active=${short(facts.unit.activeState)} result=${short(facts.unit.result)} nRestarts=${short(facts.unit.nRestarts)}${facts.unit.error ? ` error=${facts.unit.error}` : ''}`,
  );

  add(
    'journal: 起動以降の 5xx が 0 件',
    facts.fiveXxCount === 0,
    `5xx=${facts.fiveXxCount === null ? '取得できません' : facts.fiveXxCount}`,
  );

  const hc = facts.healthcheck;
  add(
    'healthcheck: ok=true / environment=production',
    hc !== null && hc.ok === true && hc.environment === 'production',
    hc === null ? '状態ファイルが無い' : `ok=${hc.ok} environment=${short(hc.environment)}`,
  );
  add(
    'healthcheck: healthCommit が対象 SHA と一致',
    hc !== null && hc.healthCommit === facts.expectedSha,
    hc === null ? '状態ファイルが無い' : `healthCommit=${short(hc.healthCommit)} expected=${facts.expectedSha}`,
  );
  add(
    'healthcheck: auth.status が ready',
    hc !== null && hc.authStatus === 'ready',
    hc === null ? '状態ファイルが無い' : `auth=${short(hc.authStatus)}（未取得なら FAIL）`,
  );
  const authWarning = hc?.warnings.find((w) => w.includes('auth')) ?? null;
  add(
    'healthcheck: auth 関連の警告が無い',
    authWarning === null,
    authWarning ?? 'なし',
  );
  const checkedAt = hc?.checkedAt ? Date.parse(hc.checkedAt) : NaN;
  const ageMin = Number.isNaN(checkedAt) ? null : Math.round(((Date.now() - checkedAt) / 60000) * 10) / 10;
  add(
    `healthcheck: 状態が新しい（${HEALTHCHECK_MAX_AGE_MINUTES} 分以内）`,
    ageMin !== null && ageMin >= 0 && ageMin <= HEALTHCHECK_MAX_AGE_MINUTES,
    ageMin === null ? 'checkedAt が無い・読めない' : `${ageMin} 分前`,
  );
  add(
    'DB: READ ONLY で件数を取得できる',
    facts.db !== null,
    facts.db === null ? `取得できません（${facts.dbError ?? '原因不明'}）` : `app_user=${facts.db.appUser} audit_log=${facts.db.auditLog} migration=${facts.db.migration}`,
  );

  add(
    'R2: 直近世代の r2.json と size/SHA-256 が一致',
    facts.offsite.ok,
    facts.offsite.ok
      ? `最新の記録 ${facts.offsite.newestAgeMinutes ?? '-'} 分前`
      : facts.offsite.problems.join(' / ') || 'NG',
  );

  return { ok: checks.every((c) => c.ok), checks };
}

export function formatChecks(report: { ok: boolean; checks: CheckResult[] }): string {
  const lines = [`本番受入: ${report.ok ? 'PASS' : 'FAIL'}`];
  for (const c of report.checks) {
    lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}（${c.detail}）`);
  }
  return lines.join('\n');
}

function httpGet(url: string, timeoutMs: number): { status: number; body: unknown; error?: string } {
  try {
    const out = execFileSync(
      'curl',
      ['-sS', '--noproxy', '*', '-m', String(Math.ceil(timeoutMs / 1000)), '-w', '\n%{http_code}', url],
      { encoding: 'utf8', timeout: timeoutMs + 1000 },
    );
    const idx = out.lastIndexOf('\n');
    const bodyText = idx >= 0 ? out.slice(0, idx) : out;
    const status = Number(out.slice(idx + 1).trim()) || 0;
    let body: unknown = null;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
    return { status, body };
  } catch (err) {
    return { status: 0, body: null, error: (err as Error).message.slice(0, 120) };
  }
}

function systemctlShow(unit: string, props: string[]): Record<string, string> {
  try {
    const out = execFileSync('systemctl', ['--user', 'show', unit, ...props.flatMap((p) => ['-p', p]), '--no-pager'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const map: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) map[line.slice(0, i)] = line.slice(i + 1);
    }
    return map;
  } catch (err) {
    return { error: (err as Error).message.slice(0, 120) };
  }
}

function countFiveXx(unit: string, since: string): number | null {
  try {
    const out = execFileSync('journalctl', ['--user', '-u', unit, '--since', since, '--no-pager'], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const matches = out.match(/"statusCode":5\d\d/g);
    return matches ? matches.length : 0;
  } catch {
    return null;
  }
}

function dbCountsWithError(db: string): { db: AcceptanceFacts['db']; error?: string } {
  const sql =
    "begin read only; select 'app_user='||(select count(*) from app_user)||' audit_log='||(select count(*) from audit_log)||' request='||(select count(*) from request)||' session='||(select count(*) from session)||' migration='||(select max(version) from schema_migrations); rollback;";
  try {
    const out = execFileSync('psql', ['-d', db, '-h', '/var/run/postgresql', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    const m = /app_user=(\d+) audit_log=(\d+) request=(\d+) session=(\d+) migration=(\S+)/.exec(out);
    if (!m) return { db: null, error: '出力を解釈できません' };
    return {
      db: {
        appUser: Number(m[1]),
        auditLog: Number(m[2]),
        request: Number(m[3]),
        session: Number(m[4]),
        migration: m[5] ?? '-',
      },
    };
  } catch (err) {
    return { db: null, error: (err as Error).message.slice(0, 120) };
  }
}

function readHealthcheck(stateDir: string): AcceptanceFacts['healthcheck'] {
  const path = join(stateDir, 'healthcheck.json');
  if (!existsSync(path)) return null;
  try {
    const d = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return {
      ok: d.ok === true,
      environment: typeof d.environment === 'string' ? d.environment : null,
      healthCommit: typeof d.healthCommit === 'string' ? d.healthCommit : null,
      authStatus: typeof d.authStatus === 'string' ? d.authStatus : null,
      warnings: Array.isArray(d.warnings) ? (d.warnings as string[]) : [],
      checkedAt: typeof d.checkedAt === 'string' ? d.checkedAt : null,
    };
  } catch {
    return null;
  }
}

export interface CollectOptions {
  baseUrl?: string;
  stateDir?: string;
  backupDir?: string;
  db?: string;
  unit?: string;
}

/** 実環境から事実を集める（読み取りのみ）。 */
export function collectFacts(expectedSha: string, options: CollectOptions = {}): AcceptanceFacts {
  const baseUrl = options.baseUrl ?? process.env.MIRAI_SF_PROD_BASE_URL ?? 'http://127.0.0.1:8783';
  const stateDir = options.stateDir ?? process.env.MIRAI_SF_PROD_STATE_DIR ?? join(homedir(), '.local/state/mirai-sf-prod');
  const backupDir = options.backupDir ?? join(stateDir, 'backups');
  const db = options.db ?? process.env.MIRAI_SF_PROD_DB ?? 'mirai_sf_prod';
  const unit = options.unit ?? 'mirai-sf-prod-api.service';

  const hz = httpGet(`${baseUrl}/healthz`, 10_000);
  const rz = httpGet(`${baseUrl}/readyz`, 10_000);
  const sys = systemctlShow(unit, ['ActiveState', 'Result', 'NRestarts', 'ActiveEnterTimestamp']);
  const since = sys.ActiveEnterTimestamp || '-1 day';
  const fiveXx = countFiveXx(unit, since);
  const dbResult = dbCountsWithError(db);
  const offsite = checkOffsiteStatus({ backupDir, count: 2, maxAgeMinutes: 90 });

  return {
    expectedSha,
    healthz: { httpStatus: hz.status, body: hz.body as HealthzBody | null, error: hz.error },
    readyz: { httpStatus: rz.status, body: rz.body as { status?: unknown } | null, error: rz.error },
    unit: {
      activeState: sys.ActiveState ?? null,
      result: sys.Result ?? null,
      nRestarts: sys.NRestarts ?? null,
      error: sys.error,
    },
    fiveXxCount: fiveXx,
    db: dbResult.db,
    dbError: dbResult.error,
    healthcheck: readHealthcheck(stateDir),
    offsite: {
      ok: offsite.ok,
      newestAgeMinutes: offsite.newestOffsiteAgeMinutes,
      problems: offsite.problems,
    },
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const unknown = args.filter((a) => a.startsWith('-') && a !== '--json' && a !== '--help' && a !== '-h');
  if (unknown.length > 0) {
    process.stderr.write(`不明なオプションです: ${unknown.join(' ')}\n${USAGE}\n`);
    process.exit(2);
  }
  const json = args.includes('--json');
  const rawSha = args.find((a) => !a.startsWith('-'));
  if (!rawSha || !/^[0-9a-f]{7,40}$/.test(rawSha)) {
    process.stderr.write(`commit SHA を指定してください。\n${USAGE}\n`);
    process.exit(2);
  }
  // 短縮 SHA はリポジトリで解決する（解決できなければ usage エラー）。
  let sha = rawSha;
  if (sha.length < 40) {
    try {
      sha = execFileSync('git', ['rev-parse', '--verify', `${sha}^{commit}`], { encoding: 'utf8' }).trim();
    } catch {
      process.stderr.write(`SHA を解決できません: ${rawSha}\n`);
      process.exit(2);
    }
  }
  try {
    const facts = collectFacts(sha);
    const report = evaluateAcceptance(facts);
    if (json) {
      const curated = {
        expectedSha: facts.expectedSha,
        healthz: {
          httpStatus: facts.healthz.httpStatus,
          status: facts.healthz.body?.status ?? null,
          environment: facts.healthz.body?.environment ?? null,
          commit: facts.healthz.body?.commit ?? null,
          dbOk: facts.healthz.body?.db?.ok ?? null,
        },
        readyz: { httpStatus: facts.readyz.httpStatus, status: facts.readyz.body?.status ?? null },
        unit: facts.unit,
        fiveXxCount: facts.fiveXxCount,
        db: facts.db,
        dbError: facts.dbError ?? null,
        healthcheck: facts.healthcheck,
        offsite: facts.offsite,
      };
      process.stdout.write(`${JSON.stringify({ ...report, facts: curated }, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatChecks(report)}\n`);
      if (facts.db) {
        process.stdout.write(
          `DB: app_user=${facts.db.appUser} audit_log=${facts.db.auditLog} request=${facts.db.request} session=${facts.db.session} migration=${facts.db.migration}\n`,
        );
      }
      if (facts.healthcheck?.warnings.length) {
        process.stdout.write(`healthcheck の警告: ${facts.healthcheck.warnings.join(' / ')}\n`);
      }
    }
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(`想定外の失敗: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
