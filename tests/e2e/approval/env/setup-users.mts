/**
 * 層①の 2 アカウント構成（正規経路）を作る。資料 44・48 と同じ方法。
 * - 管理者: seed 済み管理者を setUserRoles で approver のみに絞る（is_admin=true のまま）
 * - 一般利用者: createUser（LocalAdminActor = local-cli 経路）で requester のみ・is_admin=false
 * 3 人目以上は作らない。受付担当（desk）専任も作らない。
 * パスワードは環境変数からのみ受け取り、出力しない。
 */
import { createUser, getManagedUser, listManagedUsers, setUserActive, setUserRoles } from '../../../../src/api/auth';
import { closePool, query } from '../../../../src/api/db';

function required(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} が必要です`);
  return value;
}

function mask(email: string): string {
  const [local, domain] = email.split('@');
  return `${(local ?? '').slice(0, 3)}***@${domain ?? ''}`;
}

const approverEmail = required('APPROVER_EMAIL').toLowerCase();
const requesterEmail = required('REQUESTER_EMAIL').toLowerCase();
// 管理者のパスワードは seed が使う（SEED_ADMIN_PASSWORD）。ここでは必須であることだけ確かめる。
const _approverPassword = required('APPROVER_PASSWORD');
const requesterPassword = required('REQUESTER_PASSWORD');
const approverName = (process.env.APPROVER_DISPLAY_NAME ?? '管理者').trim();
const requesterName = (process.env.REQUESTER_DISPLAY_NAME ?? '一般利用者').trim();

const approverRow = await query<{ id: string }>('select id from app_user where lower(email)=lower($1)', [approverEmail]);
const approverId = approverRow.rows[0]?.id;
if (!approverId) throw new Error('seed 済みの管理者が見つかりません');
const approver = await getManagedUser(approverId);
if (!approver) throw new Error('seed 済みの管理者を読めません');
if (!approver.isAdmin || !approver.isActive) throw new Error('seed 済みの管理者は is_admin=true / 有効である必要があります');

// 1) 管理者: approver のみ（desk / requester を外す）。表示名も決める。
const actor = {
  userId: approverId,
  displayName: approver.displayName,
  role: 'approver' as const,
  isAdmin: true,
};
const approverAfter = await setUserRoles(approverId, ['approver'], actor, 'approval-e2e-approver-roles');
await query('update app_user set display_name=$2 where id=$1', [approverId, approverName]);

// 2) 一般利用者: createUser（local-cli 経路）。
const uid = process.getuid?.() ?? 0;
const localActor = {
  userId: null,
  displayName: `local-cli uid=${uid}`,
  role: 'system' as const,
  isAdmin: true as const,
  localAuthority: {
    method: 'local_db_owner' as const,
    uid,
    authorizationAdminId: approverId,
    accessLogin: false as const,
  },
};
let requester = (await listManagedUsers()).find((u) => u.email.toLowerCase() === requesterEmail) ?? null;
if (!requester) {
  requester = await createUser(
    {
      email: requesterEmail,
      displayName: requesterName,
      deptCode: 'eigyo',
      password: requesterPassword,
      roles: ['requester'],
      isAdmin: false,
    },
    localActor,
    'approval-e2e-requester-create',
  );
} else {
  requester = await setUserRoles(requester.id, ['requester'], actor, 'approval-e2e-requester-roles');
  await query('update app_user set display_name=$2 where id=$1', [requester.id, requesterName]);
}

// 3) それ以外の有効な利用者は無効化する（2 名だけにする）。
const users = await listManagedUsers();
const extras = users.filter((u) => u.isActive && u.id !== approverId && u.id !== requester.id);
for (const extra of extras) {
  await setUserActive(extra.id, false, actor, 'approval-e2e-deactivate-extra');
}

const finalUsers = await listManagedUsers();
const active = finalUsers.filter((u) => u.isActive);
const inactive = finalUsers.filter((u) => !u.isActive);
const summary = {
  measuredAt: new Date().toISOString(),
  approver: {
    emailMasked: mask(approverAfter.email),
    id: approverAfter.id,
    displayName: approverName,
    isAdmin: approverAfter.isAdmin,
    isActive: approverAfter.isActive,
    roles: approverAfter.roles,
  },
  requester: {
    emailMasked: mask(requester.email),
    id: requester.id,
    displayName: requesterName,
    isAdmin: requester.isAdmin,
    isActive: requester.isActive,
    roles: requester.roles,
  },
  totalUsers: finalUsers.length,
  activeUserCount: active.length,
  inactiveUserCount: inactive.length,
  extraUsersDeactivated: extras.map((u) => mask(u.email)),
};
console.log(JSON.stringify(summary, null, 2));

const ok =
  active.length === 2 &&
  inactive.length === 0 &&
  approverAfter.roles.length === 1 &&
  approverAfter.roles[0] === 'approver' &&
  approverAfter.isAdmin &&
  requester.isActive &&
  requester.roles.length === 1 &&
  requester.roles[0] === 'requester' &&
  !requester.isAdmin;
if (!ok) throw new Error(`2 アカウント構成になりませんでした（有効 ${active.length} / 無効 ${inactive.length}）`);

await closePool();
