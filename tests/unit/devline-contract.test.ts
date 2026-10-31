import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertApiUrlAllowed } from '../../src/api/issue-adapter.js';
import { buildIssueBody, inlineCode, safeIssueTitle } from '../../src/api/github.js';
import { parseRunnerResult } from '../../src/worker/runner-result.js';
import { renderPrBody } from '../../src/api/devline-verification.js';
import { createRunner, createFakeRunner } from '../../src/worker/fake-runner.js';
import { decideWorkerStart } from '../../src/worker/main.js';
import { buildFakeVerification } from '../../src/worker/fake-ci.js';
import {
  DEVLINE_POLICY,
  JOB_TRANSITIONS,
  PR_AGENTS_HEADINGS,
  PR_DECISION_ITEMS,
  afterReconcileNotFound,
  buildHandoffMarker,
  buildSnapshotYaml,
  canonicalJson,
  canonicalizeOrderYaml,
  checkChangedPaths,
  classifyIssueResponse,
  decideRepair,
  evaluateVerification,
  matchIssueByMarker,
  nextHandoffAction,
  parseDevlineTargetRepos,
  parseHandoffMarker,
  pathsRequiringHumanApproval,
  resumeDecision,
} from '../../src/shared/devline.js';
import type { RunnerInput, VerificationRecord } from '../../src/shared/devline.js';
import type { RequestRecord } from '../../src/shared/types.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const HEAD = 'c'.repeat(40);
const STAGES = ['static', 'build', 'unit', 'integration', 'e2e', 'security'];

function record(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    deliveryId: 'd1',
    source: 'fake_ci',
    ciRunId: 'run-1',
    runSequence: 1,
    runAttempt: 1,
    headSha: HEAD,
    stages: STAGES.map((stage) => ({ stage, status: 'passed' as const })),
    acResults: [{ acId: 'AC-1', testIds: ['t1'], status: 'passed' }],
    ...overrides,
  };
}

function requestRecord(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: 'REQ-2026-0001',
    orderVersion: 2,
    title: '作り物の依頼',
    kind: 'new_tool',
    applicant: '作り物 太郎',
    approver: '作り物 花子',
    status: 'approved',
    signalDecided: 'g',
    problem: 'p',
    purpose: 'q',
    users: [],
    places: [],
    scope: ['s'],
    outOfScope: [],
    criteria: ['c'],
    constraints: [],
    constraintsOther: [],
    dataHandling: [],
    parties: 'internal',
    approvals: [],
    people: 1,
    frequency: 'd',
    minutesPerTime: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    wishDate: null,
    ...overrides,
  } as unknown as RequestRecord;
}

describe('正規化とハッシュ（T-10, T-11, T-13, T-14）', () => {
  it('ADR 3章の固定値と一致する', () => {
    const lf = canonicalizeOrderYaml('a\r\nb\rc\n\n');
    expect(lf).toBe('a\nb c\n');
    expect(sha(lf)).toBe('9ffaa0f83922d4eb11e56154814a41322108bebaefba1fe7f00c4fcebde5d5fc');
    expect(sha(canonicalizeOrderYaml('t: "が"\n'))).toBe('0aa61c7c61e6ca2b5e25446f075a63630d0752acf5564ecb93f1b75c41619fac');
    expect(canonicalJson({ b: 1, a: { d: 'が', c: [1, 'x\r\ny'] } })).toBe('{"a":{"c":[1,"x\\ny"],"d":"が"},"b":1}');
  });

  it('status が変わっても版固定の本文は同じ', () => {
    const ctx = { suggested: 'y', approvalSuggested: 'g', departmentName: 'D', catalogToolName: 'T' } as const;
    const a = buildSnapshotYaml({ ...ctx, request: requestRecord() });
    const b = buildSnapshotYaml({ ...ctx, request: requestRecord({ status: 'dev' } as Partial<RequestRecord>) });
    expect(a).toBe(b);
    expect(sha(a)).toBe(sha(buildSnapshotYaml({ ...ctx, request: requestRecord() })));
    expect(a).toContain('order_version: 2');
  });

  it('NFD と NFC で同じハッシュになり、単独 CR が残らない', () => {
    const ctx = { suggested: 'g', approvalSuggested: 'g', departmentName: 'D', catalogToolName: 'T' } as const;
    const nfc = buildSnapshotYaml({ ...ctx, request: requestRecord({ title: 'が' }) });
    const nfd = buildSnapshotYaml({ ...ctx, request: requestRecord({ title: 'が' }) });
    expect(nfd).toBe(nfc);
    expect(buildSnapshotYaml({ ...ctx, request: requestRecord({ title: 'x\ry' }) })).not.toContain('\r');
  });
});

describe('遷移表（T-03）', () => {
  it('実行中の状態から cancelled へ行けない', () => {
    for (const state of ['planning', 'implementing', 'verifying', 'revising', 'reviewing'] as const) {
      expect(JOB_TRANSITIONS[state]).not.toContain('cancelled');
    }
    expect(JOB_TRANSITIONS.queued).toEqual(['planning', 'cancelled']);
    expect(JOB_TRANSITIONS.closed).toEqual([]);
  });
});

describe('許可リスト DEVLINE_TARGET_REPOS（CTO 決定 1）', () => {
  it('未設定と空はすべて拒否（空の配列）', () => {
    expect(parseDevlineTargetRepos(undefined)).toEqual([]);
    expect(parseDevlineTargetRepos('')).toEqual([]);
    expect(parseDevlineTargetRepos(' , ')).toEqual([]);
  });
  it('owner/name:repoId を読む', () => {
    expect(parseDevlineTargetRepos('a/b:12, c/d.e:34')).toEqual([
      { name: 'a/b', repoId: '12' },
      { name: 'c/d.e', repoId: '34' },
    ]);
  });
  it.each(['a/b', 'a/b:', ':12', 'a:12', 'a/b:x', 'a/b:0', 'a/../b:1', '../b:1'])('形の違う値 %s は例外', (raw) => {
    expect(() => parseDevlineTargetRepos(raw)).toThrow();
  });
});

describe('接続先の検査', () => {
  it('NODE_ENV=test ではループバック以外を拒否する', () => {
    expect(() => assertApiUrlAllowed('https://api.github.com', 'test')).toThrow(/ローカル/);
    expect(assertApiUrlAllowed('http://127.0.0.1:1234', 'test').port).toBe('1234');
  });
  it('平文の外部接続を拒否する', () => {
    expect(() => assertApiUrlAllowed('http://example.com', 'development')).toThrow();
    expect(assertApiUrlAllowed('https://api.github.com', 'development').hostname).toBe('api.github.com');
  });
});

describe('外部応答の分類と次の手', () => {
  it('分類', () => {
    const http = (status: number, bodyParsed = true, retryAfterPresent = false) =>
      classifyIssueResponse({ kind: 'http', status, bodyParsed, retryAfterPresent });
    expect(http(201)).toBe('succeeded');
    expect(http(201, false)).toBe('unknown');
    expect(http(500)).toBe('unknown');
    expect(http(422)).toBe('failed');
    expect(http(429)).toBe('rate_limited');
    expect(http(403, false, true)).toBe('rate_limited');
    expect(classifyIssueResponse({ kind: 'timeout' })).toBe('unknown');
  });
  it('sent は期限前は in_flight、期限後は reconcile', () => {
    const now = new Date('2026-10-31T00:00:00Z');
    const sentAt = new Date(now.getTime() - 1000);
    expect(nextHandoffAction({ state: 'sent', sentAt, nextAttemptAt: null }, now, { sendAllowed: true })).toBe('in_flight');
    const old = new Date(now.getTime() - 120_000);
    expect(nextHandoffAction({ state: 'sent', sentAt: old, nextAttemptAt: null }, now, { sendAllowed: true })).toBe('reconcile');
  });
  it('走査が不完全なら confirm_absent でも再作成しない', () => {
    expect(afterReconcileNotFound({ op: 'create_issue', scanComplete: false, confirmAbsent: true, sendAllowed: true })).toBe(
      'stay_unknown',
    );
    expect(afterReconcileNotFound({ op: 'create_issue', scanComplete: true, confirmAbsent: true, sendAllowed: true })).toBe(
      'resend_create',
    );
    expect(afterReconcileNotFound({ op: 'create_issue', scanComplete: true, confirmAbsent: false, sendAllowed: true })).toBe(
      'stay_unknown',
    );
  });
});

describe('マーカー（T-18, T-33）', () => {
  const marker = buildHandoffMarker({
    requestId: 'REQ-2026-0001',
    orderVersion: 3,
    op: 'create_issue',
    repo: 'a/b',
    contentSha256: 'd'.repeat(64),
  });
  const issue = (over: object) => ({ number: 1, url: 'u', body: marker, authorLogin: 'bot', isPullRequest: false, ...over });

  it('往復できる', () => {
    expect(parseHandoffMarker(`${marker}\nrest`)?.orderVersion).toBe(3);
  });
  it('1行目以外や他人や PR を一致させない', () => {
    expect(matchIssueByMarker([issue({ body: `x\n${marker}` })], marker, 'bot').found).toBeNull();
    expect(matchIssueByMarker([issue({ authorLogin: 'mallory' })], marker, 'bot').found).toBeNull();
    expect(matchIssueByMarker([issue({ isPullRequest: true })], marker, 'bot').found).toBeNull();
    expect(matchIssueByMarker([issue({})], marker, 'bot').found?.number).toBe(1);
  });
  it('Issue 本文の1行目がマーカーで、注文書の ``` でコードブロックが閉じない', () => {
    const body = buildIssueBody({
      marker,
      requestId: 'REQ-2026-0001',
      orderYaml: 'title: "```"\n',
      approver: 'a',
      signalLabel: 's',
      deptLabel: 'd',
    });
    expect(body.split('\n')[0]).toBe(marker);
    expect(body).toContain('````yaml');
  });
});

describe('policy（T-66 の基本）', () => {
  it.each([
    '.github/workflows/ci.yml',
    '.GitHub/Workflows/CI.yml',
    './.github/workflows/ci.yml',
    'src/../.github/x',
    '.env',
    'src/api/auth.ts',
    'wrangler.toml',
    'a\\b',
    'db/migrations/0009.sql',
  ])('%s は違反', (path) => {
    expect(checkChangedPaths([path]).length).toBe(1);
  });
  it('許可された場所は通る', () => {
    expect(checkChangedPaths(['src/generated/a.ts', 'tests/b.test.ts'])).toEqual([]);
  });
  it('修正の上限は同因2回・合計5回（厳しい側）', () => {
    expect(DEVLINE_POLICY.maxSameCauseRepairs).toBe(2);
    expect(DEVLINE_POLICY.maxTotalRepairs).toBe(5);
    expect(decideRepair({ total: 2, byCause: { x: 2 } }, 'x')).toEqual({ allow: false, stopReason: 'same_cause_limit' });
    expect(decideRepair({ total: 5, byCause: {} }, 'x')).toEqual({ allow: false, stopReason: 'repair_total_limit' });
    expect(decideRepair({ total: 1, byCause: { x: 1 } }, 'x')).toEqual({ allow: true });
  });
});

describe('policy の追加（B-4, B-5, B-6, M-2, M-3）', () => {
  it('ci_rerun_limit の停止は再開できない', () => {
    const decision = resumeDecision({ state: 'stopped', stopReason: 'ci_rerun_limit', resumeTo: 'verifying' });
    expect(decision).toMatchObject({ ok: false, code: 'ERR-201' });
  });
  it.each([
    'src/shared/devline.ts',
    'src/shared/domain.ts',
    'src/shared/order.ts',
    'src/worker/loop.ts',
    'src/worker/x/y.ts',
    'src/api/devline-jobs.ts',
    'src/api/app.ts',
    'src/api/http.ts',
    'src/api/audit.ts',
    'src/api/db.ts',
    'SRC/API/DB.TS',
    'src/.envrc',
    'src/prod.env',
    'src/.secrets/x',
    '.secrets/x',
  ])('%s は拒否', (path) => {
    expect(checkChangedPaths([path])).toHaveLength(1);
  });
  it('許可の判定は小文字化しない', () => {
    expect(checkChangedPaths(['SRC/generated/a.ts'])[0]?.rule).toBe('not_allowed');
    expect(checkChangedPaths(['Tests/a.test.ts'])[0]?.rule).toBe('not_allowed');
  });
  it('既存の試験の変更は人の承認が要る。新しい試験の置き場は要らない', () => {
    expect(pathsRequiringHumanApproval(['tests/unit/domain.test.ts', './tests/x.ts'])).toEqual([
      'tests/unit/domain.test.ts',
      'tests/x.ts',
    ]);
    expect(pathsRequiringHumanApproval(['tests/generated/a.test.ts', 'src/generated/a.ts'])).toEqual([]);
  });
});

describe('Runner の結果の実行時検証（M-3）', () => {
  const good = {
    status: 'succeeded',
    exitCode: 0,
    headSha: null,
    changedPaths: [],
    artifacts: [],
    logRef: null,
    usage: { inputTokens: 0, outputTokens: 0, durationSeconds: 0, costJpy: 0 },
    summary: 's',
  };
  const artifact = { kind: 'log', name: 'a.log', sha256: 'a'.repeat(64), byteSize: 1, content: 'x' };
  it('正しい結果は通す', () => {
    expect(parseRunnerResult(good)).toMatchObject({ status: 'succeeded' });
    expect(parseRunnerResult({ ...good, artifacts: [artifact] })?.artifacts).toHaveLength(1);
  });
  it.each([
    ['null', null],
    ['status', { ...good, status: 'ok' }],
    ['changedPaths', { ...good, changedPaths: 'src/a.ts' }],
    ['負の費用', { ...good, usage: { ...good.usage, costJpy: -1 } }],
    ['pr_body_draft', { ...good, artifacts: [{ ...artifact, kind: 'pr_body_draft' }] }],
    ['name の ..', { ...good, artifacts: [{ ...artifact, name: '../x' }] }],
    ['本文も保存先も無い', { ...good, artifacts: [{ ...artifact, content: null }] }],
    ['絶対パスの保存先', { ...good, artifacts: [{ ...artifact, content: null, storageRef: '/etc/passwd' }] }],
  ])('%s は拒否', (_name, raw) => {
    expect(parseRunnerResult(raw)).toBeNull();
  });
});

describe('Issue 本文とタイトルの無害化（H-1）', () => {
  const body = (approver: string): string =>
    buildIssueBody({ marker: 'm', requestId: 'REQ-2026-0001', orderYaml: 'a: 1\n', approver, signalLabel: 's', deptLabel: 'd' });
  it.each(['@someone', 'a\n# 見出し\n@b', '[x](https://example.com)', '<!-- 閉じない', '`a` ``b``'])(
    '承認者欄 %j は1行のコードに入る',
    (value) => {
      const line = body(value)
        .split('\n')
        .find((l) => l.startsWith('- 承認者:')) as string;
      expect(line).toMatch(/^- 承認者: (`+).*\1$/);
      expect(body(value).split('\n')).not.toContain('# 見出し');
      expect(
        body(value)
          .split('\n')
          .filter((l) => l.startsWith('@')),
      ).toEqual([]);
    },
  );
  it('backtick を含む値でも閉じられない', () => {
    expect(inlineCode('a`b')).toBe('``a`b``');
    expect(inlineCode('`a`')).toBe('`` `a` ``');
    expect(inlineCode('')).toBe('`（なし）`');
  });
  it('タイトルは1行で、通知やリンクになる文字を残さない', () => {
    const title = safeIssueTitle('REQ-2026-0001', 'a\n@b [c](d) <!-- e `f`');
    expect(title).not.toMatch(/[\n@<>`]/);
    expect(title.startsWith('[MSF] REQ-2026-0001 a ＠b ［c］(d)')).toBe(true);
  });
});

describe('検証の判定（T-71〜T-76, T-79）', () => {
  it('全段階 passed で合格', () => {
    expect(evaluateVerification([record()], HEAD, ['AC-1']).verdict).toBe('passed');
  });
  it('skipped と欠けは incomplete', () => {
    const skipped = record({
      stages: STAGES.map((stage) => ({ stage, status: stage === 'e2e' ? 'skipped' : 'passed' })) as never,
    });
    expect(evaluateVerification([skipped], HEAD, []).verdict).toBe('incomplete');
    const missing = record({ stages: [{ stage: 'static', status: 'passed' }] });
    expect(evaluateVerification([missing], HEAD, []).verdict).toBe('incomplete');
  });
  it('別 SHA だけなら stale', () => {
    expect(evaluateVerification([record({ headSha: 'e'.repeat(40) })], HEAD, []).verdict).toBe('stale');
  });
  it('古い run の成功で新しい失敗を上書きしない', () => {
    const failed = record({
      deliveryId: 'd2',
      ciRunId: 'run-2',
      runSequence: 2,
      stages: STAGES.map((stage) => ({ stage, status: stage === 'unit' ? 'failed' : 'passed' })) as never,
    });
    expect(evaluateVerification([failed, record()], HEAD, []).verdict).toBe('failed');
  });
  it('段階を複数の run から寄せ集めない', () => {
    const a = record({ stages: [{ stage: 'static', status: 'passed' }], runSequence: 1 });
    const b = record({ deliveryId: 'd2', ciRunId: 'run-2', runSequence: 2, stages: [{ stage: 'build', status: 'passed' }] });
    expect(evaluateVerification([a, b], HEAD, []).verdict).toBe('incomplete');
  });
  it('test ID の無い passed は未確認', () => {
    const v = evaluateVerification([record({ acResults: [{ acId: 'AC-1', testIds: [], status: 'passed' }] })], HEAD, ['AC-1']);
    expect(v.acEvidence[0]?.mark).toBe('未確認');
  });
});

describe('fake runner と起動条件（T-61, T-68, T-69）', () => {
  const input = (step: RunnerInput['step'], signal = new AbortController().signal): RunnerInput =>
    ({
      jobId: 'j',
      attemptNo: 1,
      step,
      order: { envelope: { content_sha256: 'x' }, canonicalYaml: 'y' },
      acceptanceCriteriaIds: ['AC-1'],
      policyVersion: 'p',
      baseSha: 'a'.repeat(40),
      deadlineAt: '2026-10-31T00:00:00Z',
      signal,
    }) as unknown as RunnerInput;

  it('fake は isolation=none を申告し、費用は 0 円', async () => {
    const runner = createFakeRunner('success');
    expect(runner.capability.isolation).toBe('none');
    const result = await runner.run(input('implement'));
    expect(result.usage.costJpy).toBe(0);
    const artifact = result.artifacts[0];
    expect(artifact && sha(artifact.content as string)).toBe(artifact?.sha256);
  });
  it('hang は signal が来るまで終わらない', async () => {
    const controller = new AbortController();
    const running = createFakeRunner('hang').run(input('implement', controller.signal));
    let done = false;
    void running.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    controller.abort();
    expect((await running).status).toBe('failed');
  });
  it.each(['local-isolated', 'real', 'nope'])('未実装の runner %s は ERR-405', (kind) => {
    expect(() => createRunner(kind, 'success')).toThrowError(expect.objectContaining({ code: 'ERR-405' }));
  });
  it('起動条件', () => {
    expect(decideWorkerStart({}).start).toBe(false);
    expect(decideWorkerStart({ DEVLINE_WORKER_ENABLED: '0' }).start).toBe(false);
    expect(decideWorkerStart({ DEVLINE_WORKER_ENABLED: '1', NODE_ENV: 'production' }).start).toBe(false);
    expect(decideWorkerStart({ DEVLINE_WORKER_ENABLED: '1', DEVLINE_FAKE_SCENARIO: 'x' }).start).toBe(false);
    expect(decideWorkerStart({ DEVLINE_WORKER_ENABLED: '1' })).toMatchObject({ start: true, runnerKind: 'fake' });
  });
  it('fake CI の配信 ID は決定的', () => {
    const facts = { jobId: 'j', headSha: HEAD, repairCountTotal: 1, ciRerunCount: 2 };
    const ctx = { now: new Date(), correlationId: 'c' };
    const a = buildFakeVerification(facts, 'success', ['AC-1'], ctx);
    expect(a.deliveryId).toBe(`fake:j:${HEAD}:2`);
    expect(a.runSequence).toBe(103);
    expect(a).toEqual(buildFakeVerification(facts, 'success', ['AC-1'], ctx));
  });
});

describe('PR 候補（T-88 の基本）', () => {
  it('10項目と12見出しを含み、依頼の文章を Markdown の命令にしない', () => {
    const body = renderPrBody({
      job: { id: 'j', order_version: 2, work_state: { changedPaths: ['src/a.ts'] } } as never,
      request: {
        id: 'REQ-2026-0001',
        title: '<!-- x --> @someone',
        kind: 'new_tool',
        status: 'approved',
        scope: ['s'],
        out_of_scope: [],
        criteria: ['条件1', '条件2'],
        users: ['本社の本部の担当者'],
        data_handling: [],
        signal_decided: 'g',
        issue_no: 5,
      },
      snapshotSha: 'f'.repeat(64),
      verdict: {
        verdict: 'passed',
        ciRunId: 'run',
        acEvidence: [
          { acId: 'AC-1', mark: '○', testIds: ['t'], ciRunId: 'run', headSha: HEAD, reportDigest: null },
          { acId: 'AC-2', mark: '未確認', testIds: [], ciRunId: 'run', headSha: HEAD, reportDigest: null },
        ],
      },
      stages: STAGES.map((stage) => ({ stage, status: 'passed' as const })),
    });
    for (const heading of [...PR_DECISION_ITEMS, ...PR_AGENTS_HEADINGS]) expect(body).toContain(heading);
    expect(body).toContain('○');
    expect(body).toContain('未確認');
    expect(body).toContain('未実施（fake PoC）');
    expect(body).toMatch(/モデル現場の結果\n\n対象外/);
    expect(body).not.toContain('<!--');
    expect(body).not.toMatch(/(^|[^\\])@someone/);
  });
});
