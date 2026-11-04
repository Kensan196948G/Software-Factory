import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), audit: vi.fn(async () => ({ id: 1, hash: 'hash' })) }));
vi.mock('../../src/api/db.js', () => ({
  query: (...args: unknown[]) => mocks.query(...args),
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query: mocks.query }),
}));
vi.mock('../../src/api/audit.js', () => ({ appendAudit: mocks.audit, appendAuditTx: mocks.audit }));
vi.mock('../../src/api/password.js', () => ({ passwordPolicyError: () => null, hashPassword: async () => 'HASH' }));
import { createUser, type LocalAdminActor } from '../../src/api/auth.js';
const local: LocalAdminActor = {
  userId: null,
  displayName: 'local-cli uid=1000',
  role: 'system',
  isAdmin: true,
  localAuthority: { method: 'local_db_owner', uid: 1000, authorizationAdminId: 'admin-id', accessLogin: false },
};
const input = {
  email: 'fake@example.com',
  displayName: '架空利用者',
  deptCode: 'dx',
  password: 'test-pass-not-real',
  roles: ['approver'] as ['approver'],
  isAdmin: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('select 1 from app_user')) return { rowCount: 0, rows: [] };
    if (sql.includes('select 1 from department')) return { rowCount: 1, rows: [{}] };
    if (sql.includes('insert into app_user')) return { rows: [{ id: 'new-id' }] };
    if (sql.includes('group by u.id'))
      return {
        rows: [
          {
            id: 'new-id',
            email: input.email,
            display_name: input.displayName,
            dept_code: 'dx',
            is_admin: true,
            is_active: true,
            roles: ['approver'],
            created_at: new Date(),
            deactivated_at: null,
          },
        ],
      };
    return { rows: [], rowCount: 1 };
  });
});
describe('user creation principal attribution (mock transaction)', () => {
  it('attributes CLI creation and grant to system rather than reference admin', async () => {
    await createUser(input, local, 'local-cli:test');
    const entry = (mocks.audit.mock.calls as unknown[][])[0]![1] as Record<string, unknown>;
    expect(entry).toMatchObject({
      actorUserId: null,
      role: 'system',
      action: 'user.create',
      result: 'success',
      diff: { source: 'local-cli', authority: local.localAuthority },
    });
    const grant = mocks.query.mock.calls.find(([sql]) => sql.includes('insert into user_role'))!;
    expect(grant[1]).toEqual(['new-id', 'approver', null]);
  });
  it('preserves existing HTTP administrator attribution', async () => {
    await createUser(input, { userId: 'http-admin', displayName: '管理者', role: 'approver', isAdmin: true }, 'http:test');
    const entry = (mocks.audit.mock.calls as unknown[][])[0]![1] as Record<string, unknown>;
    expect(entry).toMatchObject({ actorUserId: 'http-admin', role: 'approver' });
    expect(entry.diff).not.toHaveProperty('source');
    const grant = mocks.query.mock.calls.find(([sql]) => sql.includes('insert into user_role'))!;
    expect(grant[1]).toEqual(['new-id', 'approver', 'http-admin']);
  });
});
