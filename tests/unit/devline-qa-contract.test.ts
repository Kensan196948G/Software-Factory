/**
 * QA: DB を使わない契約の確認（T-10, T-11, T-13, T-14, T-18, T-33, T-61, T-66, T-69）。
 * 文字列の NFD は \u で明示し、ソースの正規化に左右されないようにする。
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { assertApiUrlAllowed } from '../../src/api/issue-adapter.js';
import { createRunner } from '../../src/worker/fake-runner.js';
import { decideWorkerStart } from '../../src/worker/main.js';
import {
  NON_RESUMABLE_STOP_REASONS,
  buildHandoffMarker,
  buildSnapshotYaml,
  canonicalJson,
  canonicalizeOrderYaml,
  cancelDecision,
  checkChangedPaths,
  checkOrderForHandoff,
  evaluateVerification,
  haltTarget,
  isOrderCurrent,
  matchIssueByMarker,
  nextHandoffAction,
  nextRetryAt,
  normalizeRepoPath,
  parseHandoffMarker,
  resumeDecision,
  STOP_REASONS,
} from '../../src/shared/devline.js';
import { SIGNAL_LABEL } from '../../src/shared/domain.js';
import { buildOrderYaml } from '../../src/shared/order.js';
import type { RequestRecord } from '../../src/shared/types.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const NFC_GA = '\u304c';
const NFD_GA = '\u304b\u3099';

function record(over: Partial<RequestRecord> = {}): RequestRecord {
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
    createdAt: '2026-10-01T15:30:00.000Z',
    wishDate: null,
    ...over,
  } as unknown as RequestRecord;
}
const ctx = { suggested: 'y', approvalSuggested: 'g', departmentName: 'D', catalogToolName: 'T' } as const;

describe('T-14: ADR 3章の固定値', () => {
  it('正規化・sha256・canonicalJson', () => {
    const lf = canonicalizeOrderYaml('a\r\nb\rc\n\n');
    expect(lf).toBe('a\nb c\n');
    expect(sha(lf)).toBe('9ffaa0f83922d4eb11e56154814a41322108bebaefba1fe7f00c4fcebde5d5fc');
    const nfd = canonicalizeOrderYaml(`t: "${NFD_GA}"\n`);
    const nfc = canonicalizeOrderYaml(`t: "${NFC_GA}"\n`);
    expect(nfd).toBe(nfc);
    expect(sha(nfd)).toBe('0aa61c7c61e6ca2b5e25446f075a63630d0752acf5564ecb93f1b75c41619fac');
    expect(canonicalJson({ b: 1, a: { d: NFD_GA, c: [1, 'x\r\ny'] } })).toBe(`{"a":{"c":[1,"x\\ny"],"d":"${NFC_GA}"},"b":1}`);
  });
});

describe('T-10・T-11: 決定性', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('T-10: 同じ入力から2回生成して同じハッシュ。TZ を変えても同じ', () => {
    const hashes = new Set<string>();
    for (const tz of ['UTC', 'Asia/Tokyo', 'America/New_York', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      hashes.add(sha(buildSnapshotYaml({ ...ctx, request: record() })));
      hashes.add(sha(buildSnapshotYaml({ ...ctx, request: record() })));
    }
    expect(hashes.size).toBe(1);
  });

  it('T-10: 時刻・乱数・環境変数が混ざらない（時間をおいて別のオブジェクトで生成しても同じ）', () => {
    const a = buildSnapshotYaml({ ...ctx, request: record() });
    const b = buildSnapshotYaml({ ...ctx, request: JSON.parse(JSON.stringify(record())) });
    expect(a).toBe(b);
  });

  it('T-11: status を dev にしても buildSnapshotYaml は同じ。suggested は承認記録の値を使う', () => {
    const base = buildSnapshotYaml({ ...ctx, request: record() });
    for (const status of ['dev', 'verify', 'wait'] as const) {
      expect(buildSnapshotYaml({ ...ctx, request: record({ status } as Partial<RequestRecord>) })).toBe(base);
    }
    expect(buildSnapshotYaml({ ...ctx, suggested: 'r', request: record() })).toBe(base);
    expect(base).toContain('status: "承認済み"');
    expect(base).toContain(`suggested: "${SIGNAL_LABEL.g}"`);
  });

  it('T-11: buildOrderYaml の形式は固定用の正規化で変わらない（NFC・LF の入力なら同じ文字列）', () => {
    const plain = buildOrderYaml({ request: record(), suggested: 'g', departmentName: 'D', catalogToolName: 'T' });
    expect(canonicalizeOrderYaml(plain)).toBe(plain);
  });
});

describe('T-13: 正規化', () => {
  it('タイトル・本文・リストの NFD は NFC と同じハッシュ', () => {
    const nfc = buildSnapshotYaml({
      ...ctx,
      request: record({ title: NFC_GA, problem: `x${NFC_GA}`, criteria: [NFC_GA] } as Partial<RequestRecord>),
    });
    const nfd = buildSnapshotYaml({
      ...ctx,
      request: record({ title: NFD_GA, problem: `x${NFD_GA}`, criteria: [NFD_GA] } as Partial<RequestRecord>),
    });
    expect(nfd).toBe(nfc);
    expect(sha(nfd)).toBe(sha(nfc));
  });

  it('単独 CR・CRLF が残らず、末尾の改行はちょうど1つ', () => {
    const yaml = buildSnapshotYaml({
      ...ctx,
      request: record({ title: 'x\ry', problem: 'a\r\nb', scope: ['c\rd'] } as Partial<RequestRecord>),
    });
    expect(yaml).not.toContain('\r');
    expect(yaml.endsWith('\n')).toBe(true);
    expect(yaml.endsWith('\n\n')).toBe(false);
  });
});

describe('T-15: 純関数の承認の検査', () => {
  const approval = {
    id: 'a1',
    decision: 'approved' as const,
    orderVersion: 3,
    approverUserId: 'u1',
    decidedSignal: 'g' as const,
    suggestedSignal: 'g' as const,
    at: '2026-10-01T00:00:00Z',
  };
  const input = {
    requestStatus: 'approved' as const,
    requestDeleted: false,
    requestOrderVersion: 3,
    requestSignalDecided: 'g' as const,
    latestApproval: approval,
    requestedOrderVersion: 3,
  };

  it('正の対照', () => {
    expect(checkOrderForHandoff(input).ok).toBe(true);
    expect(checkOrderForHandoff({ ...input, requestedOrderVersion: null }).ok).toBe(true);
  });

  it.each([
    ['状態が wait', { requestStatus: 'wait' }, 'ERR-205'],
    ['状態が back', { requestStatus: 'back' }, 'ERR-205'],
    ['状態が dev', { requestStatus: 'dev' }, 'ERR-205'],
    ['削除', { requestDeleted: true }, 'ERR-205'],
    ['版が0', { requestOrderVersion: 0, requestedOrderVersion: null }, 'ERR-205'],
    ['信号なし', { requestSignalDecided: null }, 'ERR-205'],
    ['承認記録なし', { latestApproval: null }, 'ERR-205'],
    ['最新が差戻し', { latestApproval: { ...approval, decision: 'returned' } }, 'ERR-205'],
    ['最新が見送り', { latestApproval: { ...approval, decision: 'held' } }, 'ERR-205'],
    ['承認記録の版が違う', { latestApproval: { ...approval, orderVersion: 2 } }, 'ERR-205'],
    ['承認記録の版が null', { latestApproval: { ...approval, orderVersion: null } }, 'ERR-205'],
    ['承認者の user id なし', { latestApproval: { ...approval, approverUserId: null } }, 'ERR-205'],
    ['信号の不一致', { latestApproval: { ...approval, decidedSignal: 'y' } }, 'ERR-205'],
    ['候補の色なし', { latestApproval: { ...approval, suggestedSignal: null } }, 'ERR-205'],
    ['旧版の指定', { requestedOrderVersion: 2 }, 'ERR-202'],
    ['未来の版の指定', { requestedOrderVersion: 4 }, 'ERR-202'],
  ])('%s は拒否', (_label, over, code) => {
    expect(checkOrderForHandoff({ ...input, ...(over as object) })).toMatchObject({ ok: false, code });
  });

  it.each(['received', 'review', 'wait', 'back', 'hold', 'cancel'] as const)('isOrderCurrent: %s は無効', (status) => {
    expect(isOrderCurrent({ requestStatus: status, requestDeleted: false, requestOrderVersion: 1, jobOrderVersion: 1 })).toBe(
      false,
    );
  });
  it('isOrderCurrent: 版の違いと削除は無効', () => {
    expect(isOrderCurrent({ requestStatus: 'approved', requestDeleted: false, requestOrderVersion: 2, jobOrderVersion: 1 })).toBe(
      false,
    );
    expect(isOrderCurrent({ requestStatus: 'approved', requestDeleted: true, requestOrderVersion: 1, jobOrderVersion: 1 })).toBe(
      false,
    );
  });
});

describe('T-18・T-33: マーカー', () => {
  const marker = buildHandoffMarker({
    requestId: 'REQ-2026-0001',
    orderVersion: 3,
    op: 'create_issue',
    repo: 'a/b',
    contentSha256: 'd'.repeat(64),
  });
  const issue = (over: object) => ({ number: 1, url: 'u', body: marker, authorLogin: 'bot', isPullRequest: false, ...over });

  it.each([
    ['2行目', { body: `x\n${marker}` }],
    ['前に空白', { body: ` ${marker}` }],
    ['後ろに文字', { body: `${marker}x` }],
    ['本文なし', { body: null }],
    ['他人', { authorLogin: 'mallory' }],
    ['作成者不明', { authorLogin: null }],
    ['大文字違いの作成者', { authorLogin: 'BOT' }],
    ['PR', { isPullRequest: true }],
  ])('一致しない: %s', (_label, over) => {
    expect(matchIssueByMarker([issue(over)], marker, 'bot').found).toBeNull();
  });

  it('版や sha が1文字違えば一致しない', () => {
    expect(matchIssueByMarker([issue({ body: marker.replace('version=3', 'version=33') })], marker, 'bot').found).toBeNull();
    expect(
      matchIssueByMarker([issue({ body: marker.replace('d'.repeat(64), `e${'d'.repeat(63)}`) })], marker, 'bot').found,
    ).toBeNull();
  });

  it('parseHandoffMarker は形の違う1行目を読まない', () => {
    expect(parseHandoffMarker(`${marker}\r\nrest`)?.orderVersion).toBe(3);
    expect(parseHandoffMarker(`x${marker}`)).toBeNull();
    expect(parseHandoffMarker('<!-- msf-handoff:v1 request=REQ-1 version=0 -->')).toBeNull();
    expect(parseHandoffMarker(null)).toBeNull();
  });
});

describe('次の手と再開の純関数', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  it('送れないときは failed / intent でも送らない', () => {
    for (const state of ['intent', 'failed'] as const) {
      expect(nextHandoffAction({ state, sentAt: null, nextAttemptAt: null }, now, { sendAllowed: false })).toBe(
        'send_not_allowed',
      );
    }
  });
  it('unknown は常に照合、succeeded は既存を返す（送れなくても）', () => {
    expect(nextHandoffAction({ state: 'unknown', sentAt: now, nextAttemptAt: null }, now, { sendAllowed: false })).toBe(
      'reconcile',
    );
    expect(nextHandoffAction({ state: 'succeeded', sentAt: now, nextAttemptAt: null }, now, { sendAllowed: false })).toBe(
      'return_existing',
    );
  });
  it('sent で sentAt が無ければ別の処理の最中とみなす', () => {
    expect(nextHandoffAction({ state: 'sent', sentAt: null, nextAttemptAt: null }, now, { sendAllowed: true })).toBe('in_flight');
  });
  it('混雑の待ち時間は 1・5・15 分で頭打ち', () => {
    const minutes = (attempts: number) => (nextRetryAt(now, attempts).getTime() - now.getTime()) / 60_000;
    expect([0, 1, 2, 3, 4, 10].map(minutes)).toEqual([1, 1, 5, 15, 15, 15]);
  });
  it('止める行き先: queued は cancelled、implementing の runner 失敗だけ failed、pr_ready 以降は動かさない', () => {
    expect(haltTarget('queued', 'runner_failure')).toBe('cancelled');
    expect(haltTarget('implementing', 'runner_failure')).toBe('failed');
    expect(haltTarget('planning', 'runner_failure')).toBe('stopped');
    expect(haltTarget('revising', 'runner_failure')).toBe('stopped');
    for (const state of ['pr_ready', 'approved', 'merged', 'stopped', 'failed', 'cancelled', 'closed'] as const) {
      expect(haltTarget(state, 'human_stop')).toBeNull();
    }
    for (const state of ['pr_ready', 'failed', 'closed', 'merged'] as const) expect(cancelDecision(state).ok).toBe(false);
  });
  it('再開先が記録されていない・closed は再開できない。理由の分類に漏れがない', () => {
    expect(resumeDecision({ state: 'stopped', stopReason: 'cancel_requested', resumeTo: null }).ok).toBe(false);
    expect(resumeDecision({ state: 'stopped', stopReason: 'cancel_requested', resumeTo: 'closed' }).ok).toBe(false);
    expect(resumeDecision({ state: 'cancelled', stopReason: 'cancel_requested', resumeTo: 'planning' }).ok).toBe(false);
    expect(resumeDecision({ state: 'stopped', stopReason: 'session_limit', resumeTo: 'planning' })).toEqual({
      ok: true,
      to: 'planning',
    });
    for (const reason of NON_RESUMABLE_STOP_REASONS) expect(STOP_REASONS).toContain(reason);
  });
});

describe('T-66: path の policy（純関数の網羅）', () => {
  it.each([
    '.github/workflows/ci.yml',
    '.github/CODEOWNERS',
    '.GITHUB/WORKFLOWS/CI.YML',
    '.GitHub/workflows/x.yaml',
    './.github/workflows/ci.yml',
    './/.github//workflows/ci.yml',
    '././.github/workflows/ci.yml',
    'src/../.github/workflows/ci.yml',
    'src/../../etc/passwd',
    '..',
    '../x',
    '.github\\workflows\\ci.yml',
    'src\\api\\auth.ts',
    '.gitlab-ci.yml',
    '.husky/pre-commit',
    '.env',
    '.ENV',
    '.env.production',
    'src/.env',
    'tests/.env.local',
    'src/a/b/.env',
    'src/server.pem',
    'src/SERVER.PEM',
    'src/private.key',
    'src/cert.p12',
    'src/id_rsa',
    'src/id_ed25519.pub',
    'src/secret.ts',
    'src/secrets/a.ts',
    'src/credentials.json',
    'tests/.aws/config',
    'src/.ssh/config',
    'src/.npmrc',
    'src/.netrc',
    'src/.pgpass',
    'src/local.json',
    'src/api/auth.ts',
    'src/api/AUTH.ts',
    'src/api//auth.ts',
    './src/api/auth.ts',
    'src/./api/auth.ts',
    'src/api/password.ts',
    'src/api/config.ts',
    'wrangler.toml',
    'src/wrangler.toml',
    'src/wrangler.jsonc',
    'Dockerfile',
    'src/Dockerfile.prod',
    'src/docker-compose.yml',
    'src/compose.prod.yaml',
    'src/deploy/run.sh',
    'src/infra/main.tf',
    'src/terraform/main.tf',
    'src/k8s/a.yaml',
    'src/helm/a.yaml',
    'src/systemd/a',
    'src/foo.service',
    'scripts/deploy.sh',
    'package.json',
    'pnpm-lock.yaml',
    'db/migrations/0009_x.sql',
    'README.md',
    'docs/spec.md',
    '/etc/passwd',
    '/src/a.ts',
    'C:\\a.ts',
    'C:/a.ts',
    '',
    '.',
    './',
    'src/a\u0000.ts',
    'src/a\n.ts',
    'ｓｒｃ/a.ts',
  ])('違反: %j', (path) => {
    expect(checkChangedPaths([path]).length).toBe(1);
  });

  it.each([
    'src/generated/a.ts',
    'tests/b.test.ts',
    'docs/orders/REQ-2026-0001.yaml',
    './src/a.ts',
    'src/env.ts',
    'src/environment/a.ts',
  ])('許可: %j', (path) => {
    expect(checkChangedPaths([path])).toEqual([]);
  });

  it('1件でも違反があれば検出し、正規化の結果は保持する', () => {
    expect(checkChangedPaths(['src/ok.ts', 'src/api/auth.ts', '.env'])).toHaveLength(2);
    expect(normalizeRepoPath('./src//a/./b.ts')).toBe('src/a/b.ts');
    expect(normalizeRepoPath('src/../a')).toBeNull();
  });
});

describe('T-41・接続先', () => {
  it('試験と平文の接続先を拒否する', () => {
    expect(() => assertApiUrlAllowed('https://api.github.com', 'test')).toThrow();
    expect(() => assertApiUrlAllowed('http://127.0.0.1.example.com', 'test')).toThrow();
    expect(() => assertApiUrlAllowed('http://example.com', 'production')).toThrow();
    expect(() => assertApiUrlAllowed('ftp://127.0.0.1', 'development')).toThrow();
    expect(() => assertApiUrlAllowed('nonsense', 'development')).toThrow();
  });
});

describe('T-61・T-69: 起動条件', () => {
  it.each(['local-isolated', 'real', 'nope', ''])('runner %j は ERR-405', (kind) => {
    expect(() => createRunner(kind, 'success')).toThrowError(expect.objectContaining({ code: 'ERR-405' }));
  });
  it.each([
    [{}, false],
    [{ DEVLINE_WORKER_ENABLED: '' }, false],
    [{ DEVLINE_WORKER_ENABLED: '0' }, false],
    [{ DEVLINE_WORKER_ENABLED: 'true' }, false],
    [{ DEVLINE_WORKER_ENABLED: '1', NODE_ENV: 'production' }, false],
    [{ DEVLINE_WORKER_ENABLED: '1', DEVLINE_FAKE_SCENARIO: 'evil' }, false],
    [{ DEVLINE_WORKER_ENABLED: '1' }, true],
    [{ DEVLINE_WORKER_ENABLED: '1', NODE_ENV: 'development', DEVLINE_FAKE_SCENARIO: 'hang' }, true],
  ])('%j → start=%s', (env, start) => {
    expect(decideWorkerStart(env).start).toBe(start);
  });
});

describe('T-72〜T-76: 判定の純関数（到着順に依存しない）', () => {
  const HEAD = 'c'.repeat(40);
  const passed = ['static', 'build', 'unit', 'integration', 'e2e', 'security'].map((stage) => ({
    stage,
    status: 'passed' as const,
  }));
  const rec = (over: object) => ({
    deliveryId: 'd',
    source: 'fake_ci' as const,
    ciRunId: 'r',
    runSequence: 1,
    runAttempt: 1,
    headSha: HEAD,
    stages: passed,
    acResults: [],
    ...over,
  });
  it('配列の順を入れ替えても結果が同じ', () => {
    const fail = rec({ runSequence: 2, stages: passed.map((s) => (s.stage === 'unit' ? { ...s, status: 'failed' } : s)) });
    const ok = rec({ runSequence: 1 });
    expect(evaluateVerification([ok, fail] as never, HEAD, []).verdict).toBe('failed');
    expect(evaluateVerification([fail, ok] as never, HEAD, []).verdict).toBe('failed');
  });
  it('source が agent の行は証跡に数えない', () => {
    expect(evaluateVerification([rec({ source: 'agent' })] as never, HEAD, []).verdict).toBe('no_result');
  });
  it('結果が無ければ no_result、別 SHA だけなら stale', () => {
    expect(evaluateVerification([], HEAD, ['AC-1']).verdict).toBe('no_result');
    expect(evaluateVerification([rec({ headSha: 'e'.repeat(40) })] as never, HEAD, ['AC-1']).verdict).toBe('stale');
  });
});
