/**
 * AC 証跡の単体試験。zip と JSON は試験の中で作る。外部へ送らない。
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildZip } from '../integration/devline-real-harness.js';
import { REQUIRED_STAGES, evaluateVerification, summarizeAc } from '../../src/shared/devline.js';
import type { AcResult, RunnerInput, VerificationRecord } from '../../src/shared/devline.js';
import { AC_ARTIFACT_MAX_BYTES, parseAcResults, readSingleJsonFromZip } from '../../src/worker/ac-artifact.js';
import { buildRunnerPrompt } from '../../src/worker/docker-claude-runner.js';
import { selectAcArtifact } from '../../src/worker/github-ci-collector.js';

const HEAD = 'a'.repeat(40);
const record = (acResults: AcResult[], over: Partial<VerificationRecord> = {}): VerificationRecord => ({
  deliveryId: 'd',
  source: 'github',
  ciRunId: 'run',
  runSequence: 1,
  runAttempt: 1,
  headSha: HEAD,
  stages: REQUIRED_STAGES.map((stage) => ({ stage, status: 'passed' as const })),
  acResults,
  ...over,
});
const ok = (acId: string): AcResult => ({ acId, status: 'passed', testIds: [`${acId}: t`] });

describe('evaluateVerification: 受入条件', () => {
  it('全件 passed（test ID あり）のときだけ passed', () => {
    expect(evaluateVerification([record([ok('AC-1'), ok('AC-2')])], HEAD, ['AC-1', 'AC-2']).verdict).toBe('passed');
  });

  it.each<[string, AcResult[]]>([
    ['報告なし', []],
    ['1件欠落', [ok('AC-1')]],
    ['not_run', [ok('AC-1'), { acId: 'AC-2', status: 'not_run', testIds: ['x'] }]],
    ['test ID なしの passed', [ok('AC-1'), { acId: 'AC-2', status: 'passed', testIds: [] }]],
    ['同じ AC の重複は曖昧なので未確認', [ok('AC-1'), ok('AC-2'), ok('AC-2')]],
  ])('%s は incomplete で、段階が揃っていても合格にしない', (_name, acs) => {
    const v = evaluateVerification([record(acs)], HEAD, ['AC-1', 'AC-2']);
    expect(v.verdict).toBe('incomplete');
    if (v.verdict !== 'incomplete') throw new Error('unreachable');
    expect(v.incompleteStages).toEqual([]);
    expect(v.unconfirmedAcs.length).toBeGreaterThan(0);
  });

  it('failed は failed（重複の中に failed があっても）', () => {
    expect(evaluateVerification([record([{ acId: 'AC-1', status: 'failed', testIds: ['t'] }])], HEAD, ['AC-1']).verdict).toBe(
      'failed',
    );
    const dup = [ok('AC-1'), { acId: 'AC-1', status: 'failed' as const, testIds: ['t'] }];
    expect(evaluateVerification([record(dup)], HEAD, ['AC-1']).verdict).toBe('failed');
  });

  it('条件が0件の注文書は確かめたものが無いので合格にしない', () => {
    const v = evaluateVerification([record([])], HEAD, []);
    expect(v.verdict).toBe('incomplete');
    expect(v.verdict === 'incomplete' && v.acMissing).toBe(true);
    expect(summarizeAc([]).label).toBe('受入条件 未確認あり');
  });

  it('文言: 全件確認 / 未確認あり / 不合格あり', () => {
    const base = { testIds: [], ciRunId: null, headSha: null, reportDigest: null };
    const e = (mark: '○' | '×' | '未確認') => ({ acId: 'AC-1', mark, ...base });
    expect(summarizeAc([e('○'), e('○')]).label).toBe('受入条件 全件確認');
    expect(summarizeAc([e('○'), e('未確認')]).label).toBe('受入条件 未確認あり');
    expect(summarizeAc([e('未確認'), e('×')]).label).toBe('受入条件 不合格あり');
  });
});

describe('readSingleJsonFromZip', () => {
  const json = '{"a":1}';
  it('deflate と無圧縮を読む', () => {
    expect(readSingleJsonFromZip(buildZip({ 'ac-results.json': json }))?.toString()).toBe(json);
    expect(readSingleJsonFromZip(buildZip({ 'ac-results.json': json }, 0))?.toString()).toBe(json);
  });

  it('.json が 0 個・2 個は読まない', () => {
    expect(readSingleJsonFromZip(buildZip({ 'a.txt': 'x' }))).toBeNull();
    expect(readSingleJsonFromZip(buildZip({ 'a.json': '1', 'b.json': '2' }))).toBeNull();
  });

  it('壊れた zip・CRC 不一致・暗号化・未知の圧縮方式を読まない', () => {
    expect(readSingleJsonFromZip(Buffer.from('not a zip'))).toBeNull();
    expect(readSingleJsonFromZip(Buffer.alloc(0))).toBeNull();
    const zip = buildZip({ 'ac-results.json': json }, 0);
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const badCrc = Buffer.from(zip);
    badCrc.writeUInt32LE(0x12345678, cd + 16);
    expect(readSingleJsonFromZip(badCrc)).toBeNull();
    const encrypted = Buffer.from(zip);
    encrypted.writeUInt16LE(1, cd + 8);
    expect(readSingleJsonFromZip(encrypted)).toBeNull();
    const method = Buffer.from(zip);
    method.writeUInt16LE(12, cd + 10);
    expect(readSingleJsonFromZip(method)).toBeNull();
  });

  it('展開後の大きさの申告を信じない（zip bomb）', () => {
    const big = Buffer.alloc(AC_ARTIFACT_MAX_BYTES + 1024, 0x20);
    const bomb = buildZip({ 'ac-results.json': big });
    expect(bomb.length).toBeLessThan(AC_ARTIFACT_MAX_BYTES);
    expect(readSingleJsonFromZip(bomb)).toBeNull();
    // 申告だけ小さくしても展開の上限で止まる
    const cd = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const lying = Buffer.from(bomb);
    lying.writeUInt32LE(10, cd + 24);
    expect(readSingleJsonFromZip(lying)).toBeNull();
    expect(deflateRawSync(big).length).toBeLessThan(AC_ARTIFACT_MAX_BYTES);
  });

  it('上限を超える zip を読まない', () => {
    expect(readSingleJsonFromZip(Buffer.alloc(AC_ARTIFACT_MAX_BYTES + 1))).toBeNull();
  });
});

describe('parseAcResults', () => {
  const doc = (over: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        schema: 'msf.ac-results/v1',
        headSha: HEAD,
        ac: [{ id: 'AC-1', status: 'passed', testIds: ['AC-1: t'] }],
        ...over,
      }),
    );

  it('正しい形を読む', () => {
    expect(parseAcResults(doc(), HEAD)).toEqual({
      ok: true,
      results: [{ acId: 'AC-1', status: 'passed', testIds: ['AC-1: t'] }],
    });
  });

  it('head が違えば使わない', () => {
    expect(parseAcResults(doc({ headSha: 'b'.repeat(40) }), HEAD)).toEqual({ ok: false, problem: 'head_mismatch' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['schema 違い', { schema: 'msf.ac-results/v2' }],
    ['ac が配列でない', { ac: {} }],
    ['ID の形', { ac: [{ id: 'AC-0', status: 'passed', testIds: ['t'] }] }],
    ['状態の値', { ac: [{ id: 'AC-1', status: 'ok', testIds: ['t'] }] }],
    ['testIds の型', { ac: [{ id: 'AC-1', status: 'passed', testIds: [1] }] }],
    ['testIds が空文字', { ac: [{ id: 'AC-1', status: 'passed', testIds: [' '] }] }],
    ['多すぎる', { ac: Array.from({ length: 201 }, () => ({ id: 'AC-1', status: 'passed', testIds: ['t'] })) }],
  ])('%s は全体を読まない', (_name, over) => {
    expect(parseAcResults(doc(over), HEAD)).toEqual({ ok: false, problem: 'invalid' });
  });

  it('JSON でない・不正な UTF-8 は読まない', () => {
    expect(parseAcResults(Buffer.from('{'), HEAD).ok).toBe(false);
    expect(parseAcResults(Buffer.from([0xff, 0xfe]), HEAD).ok).toBe(false);
  });
});

describe('selectAcArtifact', () => {
  const run = { id: 7, head_sha: HEAD, run_started_at: '2026-11-01T01:00:00Z' };
  const art = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'ac-results',
    size_in_bytes: 10,
    expired: false,
    created_at: '2026-11-01T01:05:00Z',
    workflow_run: { id: 7, head_sha: HEAD },
    ...over,
  });
  it('同じ run・同じ head の1件を選ぶ', () => {
    expect(selectAcArtifact([art()], run).ok).toBe(true);
  });
  it.each<[string, unknown[], string]>([
    ['無い', [], 'missing'],
    ['別の名前', [art({ name: 'other' })], 'missing'],
    ['別の run', [art({ workflow_run: { id: 8, head_sha: HEAD } })], 'missing'],
    ['別の head', [art({ workflow_run: { id: 7, head_sha: 'b'.repeat(40) } })], 'head_mismatch'],
    ['前の試行のもの', [art({ created_at: '2026-11-01T00:59:59Z' })], 'missing'],
    ['同じ試行に2つ', [art(), art({ id: 2 })], 'duplicate'],
    ['期限切れ', [art({ expired: true })], 'expired'],
    ['大きすぎる', [art({ size_in_bytes: AC_ARTIFACT_MAX_BYTES + 1 })], 'too_large'],
  ])('%s は使わない', (_name, list, problem) => {
    expect(selectAcArtifact(list as never, run)).toEqual({ ok: false, problem });
  });
});

describe('runner のプロンプト', () => {
  const input = (step: RunnerInput['step']): RunnerInput =>
    ({
      step,
      order: { envelope: { request_id: 'REQ-2026-0001' }, canonicalYaml: 't: 1\n' },
      acceptanceCriteriaIds: ['AC-1'],
      policyVersion: 'p',
      previousFailure: null,
    }) as unknown as RunnerInput;

  it.each(['implement', 'revise'] as const)('%s: 試験は test/unit/ に、名前の先頭は AC-n:。AI の申告は根拠にならない', (step) => {
    const prompt = buildRunnerPrompt(input(step), 'n');
    expect(prompt).toContain('test/unit/');
    expect(prompt).toContain('`AC-n:`');
    expect(prompt).toContain('あなたの申告は合格の根拠になりません');
  });
});
