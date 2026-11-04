/**
 * 依頼ごとの投入先リポジトリ（L-12）の純関数とスキーマ。
 * DB は使わない。許可の判定（設定と台帳の積集合）が1か所に閉じていることを固定する。
 */
import { describe, expect, it } from 'vitest';
import { allowedTargetRepos, listTargetRepos, readTargetRepoInput, requireTargetRepo } from '../../src/api/devline-target.js';
import { requestInputSchema, targetRepoSchema } from '../../src/api/schemas.js';
import { DEVLINE_REPO_LEDGER, findTargetRepoInLedger, type RepoAllowEntry } from '../../src/shared/devline.js';

/** 作成の本文の最小形（作り物だけ。DB もサーバも使わない）。 */
function sampleRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '工事写真の圏外保存のテスト',
    kind: 'improve_tool',
    deptCode: 'kaijo',
    applicant: 'テスト 太郎',
    problem: '作り物の問題（作業船の上では電波が弱い）。',
    purpose: '作り物の目的（圏外でも消えないようにする）。',
    users: ['現場の担当者'],
    scope: ['作り物の範囲'],
    criteria: ['作り物の合格条件'],
    decides: 'g',
    approver: 'テスト 太郎',
    ...overrides,
  };
}

const A = { name: 'msf-test/repo-a', repoId: '1001' };
const B = { name: 'msf-test/repo-b', repoId: '1002' };
/** 設定には載っているが台帳に無い repo（積集合の外）。 */
const C = { name: 'msf-test/repo-c', repoId: '1003' };

const ledger: RepoAllowEntry[] = [
  { name: A.name, repoId: A.repoId, purpose: 'QA の既定', private: true },
  { name: B.name, repoId: B.repoId, purpose: 'QA の選択', private: true },
];
const deps = { allowedRepos: [A, B, C], ledger } as unknown as Parameters<typeof listTargetRepos>[0];

describe('積集合（設定 DEVLINE_TARGET_REPOS × 台帳 DEVLINE_REPO_LEDGER）', () => {
  it('T-01: 台帳と設定の両方に載っている repo だけが候補で、順は設定の順、先頭が既定', () => {
    expect(allowedTargetRepos(deps).map((r) => r.name)).toEqual([A.name, B.name]);
    const listed = listTargetRepos(deps);
    expect(listed.defaultRepo).toBe(A.name);
    expect(listed.items).toEqual([
      { name: A.name, repoId: A.repoId, purpose: 'QA の既定', isDefault: true },
      { name: B.name, repoId: B.repoId, purpose: 'QA の選択', isDefault: false },
    ]);
  });

  it('T-02: 設定に無い repo は台帳にあっても候補にならない（両方に載っていること）', () => {
    const only = listTargetRepos({ allowedRepos: [B], ledger } as unknown as typeof deps);
    expect(only.items.map((r) => r.name)).toEqual([B.name]);
    // 既定は先頭。設定が空なら候補なし（投入は全て ERR-405）
    expect(only.defaultRepo).toBe(B.name);
    expect(listTargetRepos({ allowedRepos: [], ledger } as unknown as typeof deps)).toEqual({ items: [], defaultRepo: null });
  });

  it('T-03: 既定の台帳は Sandbox だけ（コードの定数）。設定が無ければ積集合は空', () => {
    expect(DEVLINE_REPO_LEDGER.map((r) => r.name)).toEqual(['Kensan196948G/Software-Factory-Sandbox']);
    expect(allowedTargetRepos({ allowedRepos: [] } as unknown as typeof deps)).toEqual([]);
  });

  it('T-04: repoId が台帳と違う名前は受理しない（付け替え・譲渡の検出）', () => {
    expect(findTargetRepoInLedger(A.name, [A, B, C], ledger)).toMatchObject({ name: A.name });
    expect(findTargetRepoInLedger(A.name, [{ name: A.name, repoId: '9999' }], ledger)).toBeNull();
    expect(findTargetRepoInLedger('', [A, B], ledger)).toBeNull();
    expect(findTargetRepoInLedger(null, [A, B], ledger)).toBeNull();
    expect(findTargetRepoInLedger(' msf-test/repo-b ', [A, B], ledger)).toMatchObject({ name: B.name });
  });

  it('T-05: 積集合の外は ERR-405（新しいコードを作らない）', () => {
    expect(() => requireTargetRepo(C.name, deps)).toThrowError(expect.objectContaining({ code: 'ERR-405', statusCode: 409 }));
    expect(() => requireTargetRepo('evil/repo', deps)).toThrowError(expect.objectContaining({ code: 'ERR-405' }));
    expect(requireTargetRepo(B.name, deps).repoId).toBe(B.repoId);
  });
});

describe('作成・更新の本文（targetRepoId）', () => {
  it('T-11: 未指定は provided=false（更新では現状維持、作成では NULL）', () => {
    expect(readTargetRepoInput(sampleRequest(), deps)).toEqual({ provided: false, value: null });
    expect(readTargetRepoInput(undefined, deps)).toEqual({ provided: false, value: null });
    expect(readTargetRepoInput({}, deps)).toEqual({ provided: false, value: null });
  });

  it('T-12: null / 空文字は「未指定へ戻す」', () => {
    expect(readTargetRepoInput({ targetRepoId: null }, deps)).toEqual({ provided: true, value: null });
    expect(readTargetRepoInput({ targetRepoId: '   ' }, deps)).toEqual({ provided: true, value: null });
  });

  it('T-13: 積集合に載っている名前だけを通し、前後の空白は落とす', () => {
    expect(readTargetRepoInput({ targetRepoId: B.name }, deps)).toEqual({ provided: true, value: B.name });
    expect(readTargetRepoInput({ targetRepoId: ` ${B.name} ` }, deps)).toEqual({ provided: true, value: B.name });
  });

  it('T-14: 積集合の外・台帳だけ・設定だけは ERR-405', () => {
    for (const value of ['evil/repo', C.name, 'msf-test/repo-d']) {
      expect(() => readTargetRepoInput({ targetRepoId: value }, deps)).toThrowError(expect.objectContaining({ code: 'ERR-405' }));
    }
  });

  it('T-15: requestInputSchema は targetRepoId を任意で受け、形だけを見る（許可はサーバが決める）', () => {
    const withTarget = requestInputSchema.parse(sampleRequest({ targetRepoId: B.name }));
    expect(withTarget.targetRepoId).toBe(B.name);
    const without = requestInputSchema.parse(sampleRequest());
    expect(Object.hasOwn(without, 'targetRepoId')).toBe(false);
    // 長すぎる値は形で弾く（許可の判定より前）
    expect(() => requestInputSchema.parse(sampleRequest({ targetRepoId: 'a/'.repeat(80) }))).toThrow();
  });

  it('T-16: 投入先の変更の本文は null を許し、キーは必須（消し忘れを型で防ぐ）', () => {
    expect(targetRepoSchema.parse({ targetRepoId: null })).toEqual({ targetRepoId: null });
    expect(targetRepoSchema.parse({ targetRepoId: B.name })).toEqual({ targetRepoId: B.name });
    expect(() => targetRepoSchema.parse({})).toThrow();
  });
});
