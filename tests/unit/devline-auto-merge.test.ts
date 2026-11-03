/**
 * 自動マージと複数リポジトリの許可（純関数）。DB・外部へは触らない。
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_MERGE_POLICY_VERSION,
  DEVLINE_REPO_LEDGER,
  JOB_TRANSITIONS,
  SANDBOX_DIFF_POLICY,
  SANDBOX_REPO,
  allowedLedgerRepos,
  autoMergeRepoFacts,
  checkAutoMergeDiffEvidence,
  decideAutoMerge,
  haltTarget,
  ledgerEntryFor,
  resumeDecision,
  type AutoMergeFacts,
  type RepoAllowEntry,
} from '../../src/shared/devline.js';
import {
  RealLineRefused,
  checkRealLineEnv,
  isRealRunnerTarget,
  parseAutoMergePolicy,
} from '../../src/api/devline-real-config.js';

const LEDGER: readonly RepoAllowEntry[] = [
  { name: 'example/one', repoId: '101', purpose: '試験の1件目', private: true },
  { name: 'example/two', repoId: '202', purpose: '試験の2件目', private: true },
];

const sandboxWork = { diffPolicy: SANDBOX_DIFF_POLICY.version, changedPaths: ['src/feature.js'] };

function facts(over: Partial<AutoMergeFacts> = {}): AutoMergeFacts {
  return {
    enabled: true,
    jobState: 'pr_ready',
    jobHeadSha: 'a'.repeat(40),
    superseded: false,
    orderCurrent: true,
    verdict: 'passed',
    acAllConfirmed: true,
    diff: { ok: true, policyVersion: SANDBOX_DIFF_POLICY.version, changedPaths: ['src/feature.js'] },
    repo: {
      configured: { name: SANDBOX_REPO.name, repoId: SANDBOX_REPO.repoId },
      ledger: DEVLINE_REPO_LEDGER[0] as RepoAllowEntry,
      ledgerNameMatch: true,
    },
    hasPr: true,
    mergeState: 'none',
    ...over,
  };
}

describe('許可台帳（複数リポジトリ）', () => {
  it('台帳は owner/name・repoId・用途・private 前提を持つ。Sandbox だけが既定', () => {
    expect(DEVLINE_REPO_LEDGER).toHaveLength(1);
    expect(DEVLINE_REPO_LEDGER[0]).toMatchObject({ name: SANDBOX_REPO.name, repoId: SANDBOX_REPO.repoId, private: true });
    expect(DEVLINE_REPO_LEDGER[0]?.purpose).not.toBe('');
  });

  it('設定と台帳の積集合は設定の順。repoId が違う行は落とす', () => {
    expect(
      allowedLedgerRepos(
        [
          { name: 'example/two', repoId: '202' },
          { name: 'example/one', repoId: '101' },
        ],
        LEDGER,
      ).map((r) => r.name),
    ).toEqual(['example/two', 'example/one']);
    expect(allowedLedgerRepos([{ name: 'example/two', repoId: '999' }], LEDGER)).toEqual([]);
    expect(allowedLedgerRepos([{ name: 'example/three', repoId: '303' }], LEDGER)).toEqual([]);
    expect(ledgerEntryFor('example/one', '101', LEDGER)?.name).toBe('example/one');
    expect(ledgerEntryFor('example/one', '202', LEDGER)).toBeNull();
    expect(ledgerEntryFor('example/one', undefined, LEDGER)?.name).toBe('example/one');
  });

  it('実 runner の許可は台帳との積集合。2件でも通り、台帳に無い1件で起動を拒否する', () => {
    const both = [
      { name: 'example/one', repoId: '101' },
      { name: 'example/two', repoId: '202' },
    ];
    const policy = () => SANDBOX_DIFF_POLICY;
    expect(checkRealLineEnv({}, both, LEDGER, policy)).toBeNull();
    expect(checkRealLineEnv({}, [...both, { name: 'example/three', repoId: '303' }], LEDGER, policy)).toContain('許可先以外');
    expect(checkRealLineEnv({}, [], LEDGER, policy)).toContain('許可先');
    expect(isRealRunnerTarget('example/one', both, LEDGER, policy)).toBe(true);
    expect(isRealRunnerTarget('example/three', both, LEDGER, policy)).toBe(false);
    // 台帳にあっても差分 policy が無いリポジトリは実 runner に向けない
    expect(isRealRunnerTarget('example/one', both, LEDGER, () => null)).toBe(false);
    // 既存の Sandbox の許可は変えない
    expect(isRealRunnerTarget(SANDBOX_REPO.name, [SANDBOX_REPO])).toBe(true);
    expect(isRealRunnerTarget('Kensan196948G/Software-Factory', [{ name: 'Kensan196948G/Software-Factory', repoId: '1' }])).toBe(
      false,
    );
  });
});

describe('DEVLINE_AUTO_MERGE の設定', () => {
  it('既定は無効。0 も無効', () => {
    expect(parseAutoMergePolicy({})).toEqual({ enabled: false, configuredValue: '', policyVersion: AUTO_MERGE_POLICY_VERSION });
    expect(parseAutoMergePolicy({ DEVLINE_AUTO_MERGE: '0' })).toMatchObject({ enabled: false, configuredValue: '0' });
  });

  it('1 だけで有効。読めない値は拒否する（fail-closed）', () => {
    expect(parseAutoMergePolicy({ DEVLINE_AUTO_MERGE: '1' })).toEqual({
      enabled: true,
      configuredValue: '1',
      policyVersion: AUTO_MERGE_POLICY_VERSION,
    });
    for (const raw of ['2', 'true', 'on', '-1', ' 1x']) {
      expect(() => parseAutoMergePolicy({ DEVLINE_AUTO_MERGE: raw })).toThrow(RealLineRefused);
    }
  });

  it('production では既定 0 のまま。明示 1 も APP_ENV=staging でなければ拒否する', () => {
    expect(parseAutoMergePolicy({ NODE_ENV: 'production', APP_ENV: 'production' }).enabled).toBe(false);
    expect(() => parseAutoMergePolicy({ NODE_ENV: 'production', APP_ENV: 'production', DEVLINE_AUTO_MERGE: '1' })).toThrow(
      RealLineRefused,
    );
    expect(parseAutoMergePolicy({ NODE_ENV: 'production', APP_ENV: 'staging', DEVLINE_AUTO_MERGE: '1' }).enabled).toBe(true);
    expect(parseAutoMergePolicy({ NODE_ENV: 'production', APP_ENV: 'staging' }).enabled).toBe(false);
  });
});

describe('差分検査の証跡', () => {
  it('policy の版と許可された変更 path がそろうと通る', () => {
    expect(checkAutoMergeDiffEvidence(SANDBOX_REPO.name, sandboxWork)).toEqual({
      ok: true,
      policyVersion: SANDBOX_DIFF_POLICY.version,
      changedPaths: ['src/feature.js'],
    });
  });

  it('記録が無い・版が違う・path が空・policy 違反は通さない', () => {
    expect(checkAutoMergeDiffEvidence(SANDBOX_REPO.name, { changedPaths: ['src/a.js'] })).toMatchObject({
      ok: false,
      problem: 'diff_policy_missing',
    });
    expect(
      checkAutoMergeDiffEvidence(SANDBOX_REPO.name, { diffPolicy: 'diff-policy/old', changedPaths: ['src/a.js'] }),
    ).toMatchObject({ ok: false, problem: 'diff_policy_mismatch' });
    expect(
      checkAutoMergeDiffEvidence(SANDBOX_REPO.name, { diffPolicy: SANDBOX_DIFF_POLICY.version, changedPaths: [] }),
    ).toMatchObject({ ok: false, problem: 'diff_paths_missing' });
    expect(
      checkAutoMergeDiffEvidence(SANDBOX_REPO.name, {
        diffPolicy: SANDBOX_DIFF_POLICY.version,
        changedPaths: ['.github/workflows/ci.yml'],
      }),
    ).toMatchObject({ ok: false, problem: 'diff_violation' });
    expect(
      checkAutoMergeDiffEvidence(SANDBOX_REPO.name, {
        diffPolicy: SANDBOX_DIFF_POLICY.version,
        changedPaths: ['package.json'],
      }),
    ).toMatchObject({ ok: false, problem: 'diff_violation' });
    // policy の無いリポジトリは通さない
    expect(checkAutoMergeDiffEvidence('example/one', sandboxWork)).toMatchObject({ ok: false, problem: 'diff_policy_missing' });
  });
});

describe('自動マージの判定', () => {
  it('無効なら常に disabled', () => {
    expect(decideAutoMerge(facts({ enabled: false }))).toEqual({ ok: false, reasons: ['disabled'] });
  });

  it('条件がすべて揃えば通す', () => {
    expect(decideAutoMerge(facts())).toEqual({ ok: true, alreadyMerged: false });
  });

  it('merge 済みは alreadyMerged（再送しない）', () => {
    expect(decideAutoMerge(facts({ mergeState: 'merged' }))).toEqual({ ok: true, alreadyMerged: true });
  });

  it.each([
    [{ jobState: 'stopped' as const }, 'state'],
    [{ jobHeadSha: null }, 'head_missing'],
    [{ superseded: true }, 'superseded'],
    [{ orderCurrent: false }, 'order_not_current'],
    [{ verdict: 'incomplete' as const }, 'verification'],
    [{ acAllConfirmed: false }, 'ac_unconfirmed'],
    [{ diff: { ok: false as const, problem: 'diff_violation' as const } }, 'diff_violation'],
    [{ hasPr: false }, 'no_pr'],
    [{ mergeState: 'sending' as const }, 'merge_in_progress'],
    [{ mergeState: 'unknown' as const }, 'merge_in_progress'],
    [{ mergeState: 'rejected' as const }, 'merge_rejected'],
    [{ repo: { configured: null, ledger: null, ledgerNameMatch: false } }, 'repo_not_configured'],
    [{ repo: { configured: { name: 'example/one', repoId: '101' }, ledger: null, ledgerNameMatch: false } }, 'repo_not_in_ledger'],
    [
      {
        repo: {
          configured: { name: 'example/one', repoId: '999' },
          ledger: null,
          ledgerNameMatch: true,
        },
      },
      'repo_id_mismatch',
    ],
    [
      {
        repo: {
          configured: { name: 'example/one', repoId: '101' },
          ledger: { name: 'example/one', repoId: '101', purpose: 'x', private: false as unknown as true },
          ledgerNameMatch: true,
        },
      },
      'repo_not_private',
    ],
  ])('条件不足 %o は %s で拒否する', (over, reason) => {
    const decision = decideAutoMerge(facts(over as Partial<AutoMergeFacts>));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reasons).toContain(reason);
  });

  it('複数の不足はすべて理由に残す', () => {
    const decision = decideAutoMerge(
      facts({
        jobState: 'stopped',
        verdict: 'failed',
        acAllConfirmed: false,
        orderCurrent: false,
        repo: { configured: null, ledger: null, ledgerNameMatch: false },
      }),
    );
    expect(decision).toEqual({
      ok: false,
      reasons: ['state', 'order_not_current', 'verification', 'ac_unconfirmed', 'repo_not_configured', 'repo_not_in_ledger'],
    });
  });

  it('repo の事実は名前・repoId・台帳の3つで決まる', () => {
    expect(autoMergeRepoFacts('example/two', [{ name: 'example/two', repoId: '202' }], LEDGER)).toMatchObject({
      configured: { repoId: '202' },
      ledger: { repoId: '202' },
      ledgerNameMatch: true,
    });
    expect(autoMergeRepoFacts('example/two', [{ name: 'example/two', repoId: '999' }], LEDGER)).toMatchObject({
      configured: { repoId: '999' },
      ledger: null,
      ledgerNameMatch: true,
    });
    expect(autoMergeRepoFacts('example/none', [], LEDGER)).toEqual({ configured: null, ledger: null, ledgerNameMatch: false });
  });
});

describe('自動マージ失敗の停止と再開', () => {
  it('pr_ready から止まれるのは auto_merge_failed だけ。人の取消は受けない', () => {
    expect(haltTarget('pr_ready', 'auto_merge_failed')).toBe('stopped');
    expect(haltTarget('pr_ready', 'human_stop')).toBeNull();
    expect(haltTarget('pr_ready', 'runner_failure')).toBeNull();
    expect(JOB_TRANSITIONS.pr_ready).toContain('stopped');
  });

  it('auto_merge_failed の停止は pr_ready へ再開できる（人が直してやり直す）', () => {
    expect(resumeDecision({ state: 'stopped', stopReason: 'auto_merge_failed', resumeTo: 'pr_ready' })).toEqual({
      ok: true,
      to: 'pr_ready',
    });
  });
});
