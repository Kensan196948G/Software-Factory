import { describe, expect, it, vi } from 'vitest';
import { addUserInteractively, type AddUserDependencies } from '../../scripts/ops/add-user-flow.js';
import type { ManagedUser } from '../../src/api/auth.js';

const existing: ManagedUser = {
  id: 'existing',
  email: 'member@example.com',
  displayName: '架空利用者',
  deptCode: 'dx',
  roles: ['approver'],
  isAdmin: false,
  isActive: true,
  createdAt: '',
  deactivatedAt: null,
};
function setup(answers = ['member@example.com', 'member@example.com', '架空利用者', 'dx', 'YES', 'CREATE']) {
  const ask = vi.fn(async () => answers.shift() ?? '');
  const create = vi.fn<AddUserDependencies['create']>(async (input) => ({
    ...existing,
    id: 'created',
    isAdmin: input.isAdmin === true,
    roles: input.roles,
  }));
  const d: AddUserDependencies = {
    ask,
    print: vi.fn(),
    actor: {
      userId: null,
      displayName: 'local-cli uid=1000',
      role: 'system',
      isAdmin: true,
      localAuthority: { method: 'local_db_owner', uid: 1000, authorizationAdminId: 'admin', accessLogin: false },
    },
    create,
    findUser: vi.fn(async () => null),
    departmentExists: vi.fn(async () => true),
    emailAllowed: vi.fn(() => true),
  };
  return { d, create };
}

describe('local interactive provisioning flow (mock DB, no production writes)', () => {
  it('creates exactly one approver with explicit admin grant and random password', async () => {
    const { d, create } = setup();
    expect(await addUserInteractively(d)).toBe('created');
    expect(create).toHaveBeenCalledTimes(1);
    const [input, actor, cid] = create.mock.calls[0]!;
    expect(input).toMatchObject({ email: existing.email, deptCode: 'dx', roles: ['approver'], isAdmin: true });
    expect(input.password).toMatch(/^[0-9a-f]{64}$/);
    expect(actor).toEqual(d.actor);
    expect(cid).toMatch(/^local-cli:/);
    expect(actor.userId).toBeNull();
    expect(actor.role).toBe('system');
    expect(JSON.stringify(vi.mocked(d.print).mock.calls)).not.toContain(input.password);
  });
  it('does not mutate existing users', async () => {
    const { d, create } = setup();
    d.findUser = vi.fn(async () => existing);
    expect(await addUserInteractively(d)).toBe('existing');
    expect(create).not.toHaveBeenCalled();
  });
  it.each([
    ['mismatch', ['member@example.com', 'other@example.com']],
    ['redacted', ['<EMAIL_2>']],
    ['control characters', ['member@example.com', 'member@example.com', 'bad\u001bname']],
    ['no admin choice', ['member@example.com', 'member@example.com', '架空利用者', 'dx', '']],
  ])('rejects %s without write', async (_name, answers) => {
    const { d, create } = setup(answers);
    await expect(addUserInteractively(d)).rejects.toBeDefined();
    expect(create).not.toHaveBeenCalled();
  });
  it('cancels unless exact final confirmation', async () => {
    const { d, create } = setup(['member@example.com', 'member@example.com', '架空利用者', 'dx', 'NO', 'no']);
    expect(await addUserInteractively(d)).toBe('cancelled');
    expect(create).not.toHaveBeenCalled();
  });
  it('supports nonadmin approver without implicit escalation', async () => {
    const { d, create } = setup(['member@example.com', 'member@example.com', '架空利用者', 'dx', 'NO', 'CREATE']);
    await addUserInteractively(d);
    expect(create.mock.calls[0]![0].isAdmin).toBe(false);
  });
  it.each(['emailAllowed', 'departmentExists'] as const)('rejects failed %s', async (gate) => {
    const { d, create } = setup();
    if (gate === 'emailAllowed') d.emailAllowed = () => false;
    else d.departmentExists = async () => false;
    await expect(addUserInteractively(d)).rejects.toBeDefined();
    expect(create).not.toHaveBeenCalled();
  });
  it('propagates transaction failures without printing success', async () => {
    const { d } = setup();
    d.create = async () => {
      throw new Error('transaction failure');
    };
    await expect(addUserInteractively(d)).rejects.toBeDefined();
    expect(JSON.stringify(vi.mocked(d.print).mock.calls)).not.toContain('登録成功');
  });
  it('requires admin authority before prompting', async () => {
    const { d, create } = setup();
    Object.assign(d.actor, { isAdmin: false });
    await expect(addUserInteractively(d)).rejects.toBeDefined();
    expect(d.ask).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
