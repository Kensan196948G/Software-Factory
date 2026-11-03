import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/api/db.js', () => ({ query: db.query }));
import { listApprovers } from '../../src/api/auth.js';
beforeEach(() => vi.clearAllMocks());
describe('authenticated approver directory contract', () => {
  it('queries only active approver accounts and returns stable IDs with distinguishing fields', async () => {
    db.query.mockResolvedValue({
      rows: [
        { id: 'first-id', display_name: '架空 同名', email: 'one@example.com', dept_code: 'dx' },
        { id: 'second-id', display_name: '架空 同名', email: 'two@example.com', dept_code: 'dx' },
      ],
    });
    const directory = await listApprovers();
    const sql = db.query.mock.calls[0]![0] as string;
    expect(sql).toContain("r.role = 'approver'");
    expect(sql).toContain('where u.is_active');
    expect(directory).toEqual([
      { id: 'first-id', displayName: '架空 同名', email: 'one@example.com', deptCode: 'dx' },
      { id: 'second-id', displayName: '架空 同名', email: 'two@example.com', deptCode: 'dx' },
    ]);
    expect(directory[0]!.id).not.toBe(directory[1]!.id);
  });
});
