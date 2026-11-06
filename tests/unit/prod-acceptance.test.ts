/**
 * 本番受入チェッカー（scripts/ops/prod-acceptance.ts）の単体テスト。
 * 判定は純関数 evaluateAcceptance に集約しているので、事実の組合せで固定する。
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateAcceptance, formatChecks, type AcceptanceFacts } from '../../scripts/ops/prod-acceptance.js';

const SHA = 'a'.repeat(40);

function goodFacts(overrides: Partial<AcceptanceFacts> = {}): AcceptanceFacts {
  return {
    expectedSha: SHA,
    healthz: { httpStatus: 200, body: { status: 'ok', environment: 'production', commit: SHA, db: { ok: true } } },
    readyz: { httpStatus: 200, body: { status: 'ready' } },
    unit: { activeState: 'active', result: 'success', nRestarts: '0' },
    fiveXxCount: 0,
    db: { appUser: 2, auditLog: 9, request: 0, session: 0, migration: '0016_x' },
    healthcheck: { ok: true, environment: 'production', healthCommit: SHA, authStatus: 'ready', warnings: [] },
    offsite: { ok: true, newestAgeMinutes: 12.3, problems: [] },
    ...overrides,
  };
}

describe('evaluateAcceptance', () => {
  it('すべて揃えば ok', () => {
    const report = evaluateAcceptance(goodFacts());
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(10);
  });

  it('commit が一致しなければ FAIL', () => {
    const facts = goodFacts();
    facts.healthz.body = { ...facts.healthz.body, commit: 'b'.repeat(40) };
    const report = evaluateAcceptance(facts);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes('commit が対象 SHA'))?.ok).toBe(false);
  });

  it('environment が production でなければ FAIL', () => {
    const facts = goodFacts();
    facts.healthz.body = { ...facts.healthz.body, environment: 'staging' };
    expect(evaluateAcceptance(facts).ok).toBe(false);
  });

  it('db.ok が false なら FAIL', () => {
    const facts = goodFacts();
    facts.healthz.body = { ...facts.healthz.body, db: { ok: false } };
    expect(evaluateAcceptance(facts).ok).toBe(false);
  });

  it('readyz が ready でなければ FAIL', () => {
    const facts = goodFacts();
    facts.readyz = { httpStatus: 200, body: { status: 'starting' } };
    expect(evaluateAcceptance(facts).ok).toBe(false);
  });

  it('unit が active でなければ FAIL', () => {
    const facts = goodFacts();
    facts.unit = { activeState: 'failed', result: 'exit-code', nRestarts: '2' };
    expect(evaluateAcceptance(facts).ok).toBe(false);
  });

  it('5xx があれば FAIL、取得できなければ FAIL', () => {
    expect(evaluateAcceptance(goodFacts({ fiveXxCount: 2 })).ok).toBe(false);
    expect(evaluateAcceptance(goodFacts({ fiveXxCount: null })).ok).toBe(false);
  });

  it('healthcheck の状態ファイルが無ければ FAIL', () => {
    expect(evaluateAcceptance(goodFacts({ healthcheck: null })).ok).toBe(false);
  });

  it('healthcheck の commit が古ければ FAIL', () => {
    const facts = goodFacts();
    facts.healthcheck = { ok: true, environment: 'production', healthCommit: 'c'.repeat(40), authStatus: 'ready', warnings: [] };
    const report = evaluateAcceptance(facts);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes('healthCommit'))?.ok).toBe(false);
  });

  it('auth.status が misconfigured なら FAIL', () => {
    const facts = goodFacts();
    facts.healthcheck = { ok: true, environment: 'production', healthCommit: SHA, authStatus: 'misconfigured', warnings: [] };
    const report = evaluateAcceptance(facts);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes('auth.status'))?.ok).toBe(false);
  });

  it('オフサイトが NG なら FAIL', () => {
    const facts = goodFacts();
    facts.offsite = { ok: false, newestAgeMinutes: 300, problems: ['最新の記録が古すぎます'] };
    const report = evaluateAcceptance(facts);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.startsWith('R2:'))?.ok).toBe(false);
  });

  it('http エラーでも例外にせず FAIL にする', () => {
    const facts = goodFacts();
    facts.healthz = { httpStatus: 0, body: null, error: 'connection refused' };
    const report = evaluateAcceptance(facts);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.detail).toContain('connection refused');
  });
});

describe('formatChecks', () => {
  it('PASS/FAIL と詳細を人が読める形で返す', () => {
    const ok = formatChecks(evaluateAcceptance(goodFacts()));
    expect(ok.split('\n')[0]).toBe('本番受入: PASS');
    expect(ok.split('\n').slice(1).every((l) => l.startsWith('PASS  '))).toBe(true);

    const ng = formatChecks(evaluateAcceptance(goodFacts({ fiveXxCount: 1 })));
    expect(ng.split('\n')[0]).toBe('本番受入: FAIL');
    expect(ng.split('\n').some((l) => l.startsWith('FAIL  '))).toBe(true);
  });
});

describe('CLI（scripts/ops/prod-acceptance.ts）', () => {
  const tsx = join(process.cwd(), 'node_modules/.bin/tsx');
  const script = join(process.cwd(), 'scripts/ops/prod-acceptance.ts');

  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(tsx, [script, ...args], { encoding: 'utf8' });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  it('--help は exit 0', () => {
    const res = run(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('使い方');
  });

  it('SHA が無ければ exit 2', () => {
    const res = run([]);
    expect(res.status).toBe(2);
  });

  it('SHA の形式が不正なら exit 2', () => {
    const res = run(['not-a-sha']);
    expect(res.status).toBe(2);
  });
});
