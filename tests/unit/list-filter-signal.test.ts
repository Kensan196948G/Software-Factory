import { describe, expect, it } from 'vitest';
import { DATA_HANDLING, SAFETY_APPROVALS, evaluateSignal } from '../../src/shared/domain.js';
import { suggestedSignalCaseSql, suggestedSignalParams } from '../../src/api/repo.js';

/**
 * L-08: 一覧の信号の色の絞り込みを SQL へ移した。SQL の CASE は `shared/domain.ts` の
 * `evaluateSignal` と同じ判定でなければならない（画面の候補色・詳細・注文書と食い違うため）。
 *
 * SQL そのものは結合試験（tests/integration/list-filter.test.ts）で実際の PostgreSQL に対して
 * 突き合わせる。ここでは、その SQL へ渡す条件の配列と、判定の規則（引き上げのみ）が
 * ずれていないことを固定する。
 */

const color = (input: Parameters<typeof evaluateSignal>[0]) => evaluateSignal(input).color;

describe('信号の色: SQL へ渡す条件の配列', () => {
  it('DATA_HANDLING のどのキーも黄へ引き上げる（SQL の && 条件と同じ）', () => {
    const [dataKeys] = suggestedSignalParams();
    expect(dataKeys).toEqual(DATA_HANDLING.map((d) => d.key));
    for (const key of dataKeys) {
      expect({ key, color: color({ decides: 'g', dataHandling: [key] }) }).toEqual({ key, color: 'y' });
    }
  });

  it('SAFETY_APPROVALS のどの承認も黄へ引き上げる（SQL の && 条件と同じ）', () => {
    const [, safety] = suggestedSignalParams();
    expect(safety).toEqual([...SAFETY_APPROVALS]);
    for (const approval of safety) {
      expect({ approval, color: color({ decides: 'g', approvals: [approval] }) }).toEqual({ approval, color: 'y' });
    }
  });

  it('知らない値では色を上げない（SQL の配列比較が「該当なし」になるのと同じ）', () => {
    expect(color({ decides: 'g', dataHandling: ['unknown-key'], approvals: ['知らない承認'] })).toBe('g');
    expect(color({ decides: 'g', parties: 'internal' })).toBe('g');
    expect(color({ decides: 'g', catalogSignal: 'g' })).toBe('g');
    expect(color({ decides: 'g', catalogSignal: null })).toBe('g');
  });
});

describe('信号の色: 引き上げのみ（SQL の CASE の分岐と同じ）', () => {
  it('decides とカタログの色だけで赤になり、ほかの条件は黄まで', () => {
    expect(color({ decides: 'r' })).toBe('r');
    expect(color({ decides: 'y', dataHandling: ['photo'], parties: 'client' })).toBe('y');
    expect(color({ decides: 'g', catalogSignal: 'r' })).toBe('r');
    expect(color({ decides: 'g', catalogSignal: 'y' })).toBe('y');
    // 赤より下へは下げない
    expect(color({ decides: 'r', dataHandling: [], parties: 'internal' })).toBe('r');
    expect(color({ decides: 'r', catalogSignal: 'g' })).toBe('r');
  });

  it('条件を足しても色は下がらない', () => {
    const base = { decides: 'g', dataHandling: [], parties: 'internal', approvals: [] };
    const added = [
      { ...base, dataHandling: ['photo'] },
      { ...base, parties: 'partner' },
      { ...base, approvals: [SAFETY_APPROVALS[0]] },
      { ...base, approvals: [SAFETY_APPROVALS[1]] },
      { ...base, catalogSignal: 'y' },
      { ...base, decides: 'y' },
      { ...base, decides: 'r' },
    ];
    const rank = { g: 0, y: 1, r: 2 } as const;
    for (const input of added) {
      expect(rank[color(input)]).toBeGreaterThanOrEqual(rank[color(base)]);
    }
  });
});

describe('信号の色: SQL の CASE の形', () => {
  it('3色の分岐を持ち、渡した位置のパラメータだけを参照する', () => {
    const sql = suggestedSignalCaseSql(7, 8);
    expect(sql).toContain("then 'r'");
    expect(sql).toContain("then 'y'");
    expect(sql).toContain("else 'g'");
    expect(sql).toContain('$7::text[]');
    expect(sql).toContain('$8::text[]');
    expect(sql).not.toContain('$1');
  });
});
