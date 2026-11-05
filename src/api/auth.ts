import { randomBytes, createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import { config, isAccessAutoProvisionEnabled, isAccessHeaderTrustEnabled, isAccessJwtEnabled } from './config.js';
import { createAccessJwtVerifier, type AccessJwtVerifier } from './access-jwt.js';
import { hashPassword, verifyPassword, passwordPolicyError } from './password.js';
import { ApiError, Errors } from './http.js';
import { appendAudit, appendAuditTx } from './audit.js';
import type { Role } from '../shared/domain.js';
import type { SessionUser } from '../shared/types.js';

export const SESSION_COOKIE = 'msf_session';
export const CSRF_COOKIE = 'msf_csrf';

export interface SessionRow {
  id: string;
  user_id: string;
  acting_role: Role;
  csrf_token: string;
  expires_at: Date;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  dept_code: string;
  is_admin: boolean;
  password_hash: string;
  roles: Role[];
}

interface SessionJoinRow extends SessionRow {
  display_name: string;
  email: string;
  dept_code: string;
  is_admin: boolean;
  roles: Role[];
}

const ROLE_ORDER: Role[] = ['requester', 'desk', 'approver'];

function sortRoles(roles: Role[]): Role[] {
  return [...roles].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const USER_WITH_ROLES = `
  select u.id, u.email, u.display_name, u.dept_code, u.is_admin, u.password_hash,
         coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
    from app_user u
    left join user_role r on r.user_id = u.id
   where u.email = $1 and u.is_active
   group by u.id`;

const SESSION_WITH_USER = `
  select s.id, s.user_id, s.acting_role, s.csrf_token, s.expires_at,
         u.display_name, u.email, u.dept_code, u.is_admin,
         coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
    from session s
    join app_user u on u.id = s.user_id and u.is_active
    left join user_role r on r.user_id = u.id
   where s.id = $1
   group by s.id, u.id`;

/** ログイン。失敗しても理由（ID 有無）は返さない。 */
export async function login(
  email: string,
  password: string,
  ip: string,
): Promise<{ token: string; csrf: string; user: SessionUser; expiresAt: Date }> {
  const result = await query<UserRow>(USER_WITH_ROLES, [email.trim().toLowerCase()]);
  const row = result.rows[0] ?? null;
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    await appendAudit({
      action: 'login_failed',
      targetType: 'session',
      result: 'denied',
      actorName: email.slice(0, 80),
      role: 'system',
      diff: { ip },
    }).catch(() => undefined);
    throw Errors.sessionExpired();
  }

  const roles: Role[] = sortRoles(row.roles.length > 0 ? row.roles : ['requester']);
  const actingRole: Role = roles.includes('desk') ? 'desk' : roles[0]!;
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);

  await query(`insert into session (id, user_id, acting_role, csrf_token, expires_at) values ($1,$2,$3,$4,$5)`, [
    hashToken(token),
    row.id,
    actingRole,
    csrf,
    expiresAt,
  ]);
  await appendAudit({
    action: 'login',
    targetType: 'session',
    targetId: row.id,
    result: 'success',
    actorUserId: row.id,
    actorName: row.display_name,
    role: actingRole,
    diff: { ip },
  }).catch(() => undefined);

  return {
    token,
    csrf,
    expiresAt,
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      deptCode: row.dept_code,
      isAdmin: row.is_admin,
      roles,
      actingRole,
    },
  };
}

export interface AuthContext {
  session: SessionRow;
  user: SessionUser;
}

export async function resolveSession(req: FastifyRequest): Promise<AuthContext | null> {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const sessionId = hashToken(raw);
  const result = await query<SessionJoinRow>(SESSION_WITH_USER, [sessionId]);
  const found = result.rows[0];
  if (!found) return null;
  if (new Date(found.expires_at).getTime() < Date.now()) {
    await query('delete from session where id = $1', [sessionId]);
    return null;
  }
  const roles: Role[] = sortRoles(found.roles.length > 0 ? found.roles : ['requester']);
  const actingRole: Role = roles.includes(found.acting_role) ? found.acting_role : roles[0]!;
  return {
    session: {
      id: found.id,
      user_id: found.user_id,
      acting_role: actingRole,
      csrf_token: found.csrf_token,
      expires_at: found.expires_at,
    },
    user: {
      id: found.user_id,
      email: found.email,
      displayName: found.display_name,
      deptCode: found.dept_code,
      isAdmin: found.is_admin,
      roles,
      actingRole,
    },
  };
}

/** サービストークンは「管理者の代理」として扱う（自動検証用）。 */
function serviceTokenIdentity(): string {
  return (config.accessAllowedEmails[0] ?? config.seedAdminEmail).toLowerCase();
}

/**
 * 従来動作: Cloudflare Access のヘッダをそのまま信頼する。
 * JWT 未設定でも、明示 opt-in（ACCESS_TRUST_EMAIL_HEADER=1・本番/staging 以外）があるときだけ使う（Issue #102）。
 */
function identityFromAccessHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const emailHeader = headers['cf-access-authenticated-user-email'];
  if (typeof emailHeader === 'string' && emailHeader && isAccessEmailAllowed(emailHeader)) {
    return emailHeader.toLowerCase();
  }
  const clientId = headers['cf-access-client-id'];
  if (typeof clientId === 'string' && config.accessServiceTokenIds.includes(clientId)) {
    return serviceTokenIdentity();
  }
  return null;
}

/** 検証済み JWT の claim から利用者を決める。email があれば email だけで判定する。 */
function identityFromAccessClaims(claims: Record<string, unknown>): string | null {
  if (typeof claims.email === 'string' && claims.email.trim()) {
    return isAccessEmailAllowed(claims.email) ? claims.email.trim().toLowerCase() : null;
  }
  const commonName = claims.common_name;
  if (typeof commonName === 'string' && config.accessServiceTokenIds.includes(commonName)) {
    return serviceTokenIdentity();
  }
  return null;
}

let accessVerifier: { settings: string; verifier: AccessJwtVerifier } | null = null;

function accessJwtVerifier(): AccessJwtVerifier {
  const settings = `${config.accessTeamDomain}|${config.accessAud}`;
  if (accessVerifier?.settings !== settings) {
    const verifier = createAccessJwtVerifier({
      teamDomain: config.accessTeamDomain,
      aud: config.accessAud,
      onJwksError: (message) => console.warn(`Access の公開鍵を取得できません: ${message}`),
    });
    accessVerifier = { settings, verifier };
  }
  return accessVerifier.verifier;
}

/**
 * Cloudflare Access の情報から利用者を決める（メール or サービストークン）。
 * JWT 検証が有効なら Cf-Access-Jwt-Assertion だけを見て、ヘッダのメール・クライアントIDは使わない。
 * JWT 未設定なら、明示 opt-in がない限りヘッダを信頼せず null を返す（fail-closed。Issue #102）。
 */
export async function resolveAccessIdentity(
  headers: Record<string, string | string[] | undefined>,
  log?: { warn: (obj: { reason: string }, msg: string) => void },
): Promise<string | null> {
  if (!isAccessJwtEnabled(config)) {
    if (!isAccessHeaderTrustEnabled(config)) return null;
    return identityFromAccessHeaders(headers);
  }
  const token = headers['cf-access-jwt-assertion'];
  if (typeof token !== 'string' || !token) return null;
  const result = await accessJwtVerifier().verify(token);
  if (!result.ok) {
    log?.warn({ reason: result.reason }, 'Access の JWT を拒否しました');
    return null;
  }
  return identityFromAccessClaims(result.claims);
}

export function isAccessEmailAllowed(email: string): boolean {
  const value = email.trim().toLowerCase();
  if (!value) return false;
  if (config.accessAllowedEmails.includes(value)) return true;
  if (config.accessAllowedDomain && value.endsWith(`@${config.accessAllowedDomain}`)) return true;
  return false;
}

/**
 * Cloudflare Access の認証済みメールからセッションを作る（AUTH_MODE=access）。
 * 未登録の利用者は、明示 opt-in（ACCESS_AUTO_PROVISION=1・本番/staging 以外）があるときだけ
 * 最小権限（is_admin=false・requester のみ）で作る。既定は作らずに拒否する（Issue #102 の完了条件 3）。
 * 本番は Entra ID のグループで役割を決める（現状は未実装）。
 */
export async function accessLogin(
  email: string,
  ip: string,
): Promise<{ ctx: AuthContext; token: string; csrf: string; expiresAt: Date }> {
  const normalized = email.trim().toLowerCase();
  if (!isAccessEmailAllowed(normalized)) throw Errors.noPermission();

  let user = (await query<UserRow>(USER_WITH_ROLES, [normalized])).rows[0] ?? null;
  if (!user) {
    // 未登録の利用者は既定で作らない（ADR §8-9「管理者の自動付与の廃止」）。
    // Access を通れば誰でも利用者になれる経路を塞ぎ、利用者は管理API（/api/admin/users）で作る。
    // 開発・テストで利便性が必要な場合だけ ACCESS_AUTO_PROVISION=1 を明示する（本番・staging は起動エラー）。
    if (!isAccessAutoProvisionEnabled(config)) {
      await appendAudit({
        action: 'auth.access_denied',
        targetType: 'user',
        targetId: null,
        result: 'denied',
        actorName: normalized,
        role: 'system',
        diff: { reason: 'user_not_registered', appEnv: config.appEnv },
      });
      throw Errors.noPermission();
    }
    // opt-in でも最小権限にする（is_admin=false・requester のみ）。作った事実は監査に残す。
    const randomHash = await hashPassword(randomBytes(32).toString('base64url'));
    const id = await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into app_user (email, display_name, dept_code, password_hash, is_admin)
         values ($1,$2,$3,$4,false) returning id`,
        [normalized, normalized.split('@')[0] ?? normalized, 'dx', randomHash],
      );
      const newId = inserted.rows[0]?.id;
      if (!newId) throw Errors.internal();
      await client.query(`insert into user_role (user_id, role) values ($1,'requester') on conflict do nothing`, [newId]);
      await appendAuditTx(client, {
        action: 'user.provisioned',
        targetType: 'user',
        targetId: newId,
        result: 'success',
        actorUserId: null,
        actorName: 'system',
        role: 'system',
        diff: {
          email: normalized,
          isAdmin: false,
          roles: ['requester'],
          source: 'access_auto_provision',
          appEnv: config.appEnv,
        },
      });
      return newId;
    });
    if (!id) throw Errors.internal();
    user = (await query<UserRow>(USER_WITH_ROLES, [normalized])).rows[0] ?? null;
    if (!user) throw Errors.internal();
  }

  const roles: Role[] = sortRoles(user.roles.length > 0 ? user.roles : ['requester']);
  const actingRole: Role = roles.includes('desk') ? 'desk' : roles[0]!;
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  const sessionId = hashToken(token);
  await query(`insert into session (id, user_id, acting_role, csrf_token, expires_at) values ($1,$2,$3,$4,$5)`, [
    sessionId,
    user.id,
    actingRole,
    csrf,
    expiresAt,
  ]);
  await appendAudit({
    action: 'login_access',
    targetType: 'session',
    targetId: user.id,
    result: 'success',
    actorUserId: user.id,
    actorName: user.display_name,
    role: actingRole,
    diff: { ip, email: normalized },
  }).catch(() => undefined);

  return {
    ctx: {
      session: { id: sessionId, user_id: user.id, acting_role: actingRole, csrf_token: csrf, expires_at: expiresAt },
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        deptCode: user.dept_code,
        isAdmin: user.is_admin,
        roles,
        actingRole,
      },
    },
    token,
    csrf,
    expiresAt,
  };
}

export function requireAuth(ctx: AuthContext | null): AuthContext {
  if (!ctx) throw Errors.sessionExpired();
  return ctx;
}

/** 更新系の CSRF 検証（トークン一致 + Origin 許可）。 */
export function verifyCsrf(req: FastifyRequest, ctx: AuthContext): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const header = req.headers['x-csrf-token'];
  if (typeof header !== 'string' || header !== ctx.session.csrf_token) throw Errors.noPermission();
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers.host;
    const allowed = new Set([
      config.appBaseUrl,
      ...(host ? [`http://${host}`, `https://${host}`] : []),
      ...(process.env.EXTRA_ORIGINS ?? '').split(',').filter(Boolean),
    ]);
    if (!allowed.has(origin)) throw Errors.noPermission();
  }
}

export async function logout(ctx: AuthContext): Promise<void> {
  await query('delete from session where id = $1', [ctx.session.id]);
  await appendAudit({
    action: 'logout',
    targetType: 'session',
    targetId: ctx.user.id,
    result: 'success',
    actorUserId: ctx.user.id,
    actorName: ctx.user.displayName,
    role: ctx.user.actingRole,
  }).catch(() => undefined);
}

/** 検証用のロール切替（試作の動作確認用。本番では Entra ID のグループで判定する）。 */
export async function switchRole(ctx: AuthContext, role: Role): Promise<void> {
  if (!ctx.user.roles.includes(role)) throw Errors.noPermission();
  await query('update session set acting_role = $1 where id = $2', [role, ctx.session.id]);
  await appendAudit({
    action: 'role_switch',
    targetType: 'session',
    targetId: ctx.user.id,
    result: 'success',
    actorUserId: ctx.user.id,
    actorName: ctx.user.displayName,
    role,
    diff: { from: ctx.user.actingRole, to: role },
  }).catch(() => undefined);
  ctx.user.actingRole = role;
  ctx.session.acting_role = role;
}

export function setSessionCookies(reply: FastifyReply, token: string, csrf: string, expiresAt: Date): void {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/', maxAge });
  reply.setCookie(CSRF_COOKIE, csrf, { httpOnly: false, sameSite: 'lax', secure: config.cookieSecure, path: '/', maxAge });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

/** ログイン試行の簡易レート制限（IP・15分で10回）。 */
const attempts = new Map<string, { count: number; resetAt: number }>();

export function checkLoginRate(ip: string): void {
  // テストでは同一IPから繰り返しログインするため制限しない（本番・開発では有効）
  if (config.nodeEnv === 'test') return;
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 15 * 60_000 });
    return;
  }
  entry.count += 1;
  if (entry.count > 10) throw Errors.busy();
}

/** テスト・シード用にセッションを直接作る。 */
export async function createSessionForUser(
  userId: string,
  actingRole: Role,
  client?: PoolClient,
): Promise<{ token: string; csrf: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  const sql = `insert into session (id, user_id, acting_role, csrf_token, expires_at) values ($1,$2,$3,$4,$5)`;
  const params = [hashToken(token), userId, actingRole, csrf, expiresAt];
  if (client) await client.query(sql, params);
  else await query(sql, params);
  return { token, csrf, expiresAt };
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(fn);
}

/* ───────────────────────── 利用者管理（職務分離のための管理APIの土台） ───────────────────────── */

/**
 * 管理APIを呼ぶ人。isAdmin を必ず持たせ、権限の判定を呼び出し側の申告に依存させない。
 * service.ts の Actor とは別に、auth 側で完結する最小の形にする（依存の向きを循環させない）。
 */
export interface AdminActor {
  userId: string;
  displayName: string;
  role: Role;
  isAdmin: boolean;
}

export interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  deptCode: string;
  isAdmin: boolean;
  isActive: boolean;
  roles: Role[];
  createdAt: string;
  deactivatedAt: string | null;
}

/** 承認者マスタ（approver ロールを持つ有効な利用者）。 */
export interface ApproverEntry {
  id: string;
  displayName: string;
  email: string;
  deptCode: string;
}

interface ManagedUserRow {
  id: string;
  email: string;
  display_name: string;
  dept_code: string;
  is_admin: boolean;
  is_active: boolean;
  created_at: Date;
  deactivated_at: Date | null;
  roles: string[];
}

const MANAGED_USER_SELECT = `
  select u.id, u.email, u.display_name, u.dept_code, u.is_admin, u.is_active,
         u.created_at, u.deactivated_at,
         coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
    from app_user u
    left join user_role r on r.user_id = u.id`;

function toManagedUser(row: ManagedUserRow): ManagedUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    deptCode: row.dept_code,
    isAdmin: row.is_admin,
    isActive: row.is_active,
    roles: sortRoles(normalizeRoles(row.roles)),
    createdAt: new Date(row.created_at).toISOString(),
    deactivatedAt: row.deactivated_at ? new Date(row.deactivated_at).toISOString() : null,
  };
}

/** 受け取ったロールを、サーバが扱う3役に正規化する（重複・未知の値は落とす）。 */
export function normalizeRoles(roles: readonly string[]): Role[] {
  const wanted = new Set<Role>();
  for (const role of roles) {
    if (ROLE_ORDER.includes(role as Role)) wanted.add(role as Role);
  }
  return ROLE_ORDER.filter((role) => wanted.has(role));
}

function invalidUserField(message: string, field: string): ApiError {
  return new ApiError('ERR-003', message, 400, { field });
}

function duplicateEmailError(): ApiError {
  return new ApiError('ERR-004', 'このメールアドレスは既に使われています', 400, { field: 'email' });
}

/** Trusted local maintenance only; never accepted from HTTP request bodies. */
export interface LocalAdminActor {
  userId: null;
  displayName: string;
  role: 'system';
  isAdmin: true;
  localAuthority: { method: 'local_db_owner'; uid: number; authorizationAdminId: string; accessLogin: false };
}
type UserCreationActor = AdminActor | LocalAdminActor;

function userAdminDiff(actor: UserCreationActor, diff: unknown): unknown {
  return actor.role === 'system'
    ? { ...(diff as Record<string, unknown>), source: 'local-cli', authority: actor.localAuthority }
    : diff;
}

function requireAdmin(actor: UserCreationActor): void {
  if (!actor.isAdmin) throw Errors.noPermission();
}

async function auditUserAdmin(
  client: PoolClient,
  actor: UserCreationActor,
  action: string,
  targetId: string | null,
  result: 'success' | 'denied' | 'error',
  diff: unknown,
  correlationId: string,
): Promise<void> {
  await appendAuditTx(client, {
    action,
    targetType: 'user',
    targetId,
    result,
    actorUserId: actor.userId,
    actorName: actor.displayName,
    role: actor.role,
    diff: userAdminDiff(actor, diff),
    correlationId,
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/** 全利用者（無効を含む）。管理API専用。パスワードのハッシュは返さない。 */
export async function listManagedUsers(): Promise<ManagedUser[]> {
  const { rows } = await query<ManagedUserRow>(`${MANAGED_USER_SELECT} group by u.id order by u.created_at, u.email`);
  return rows.map(toManagedUser);
}

/** 1人分の利用者。見つからなければ null。 */
export async function getManagedUser(userId: string): Promise<ManagedUser | null> {
  const found = await query<ManagedUserRow>(`${MANAGED_USER_SELECT} where u.id = $1 group by u.id`, [userId]);
  return found.rows[0] ? toManagedUser(found.rows[0]) : null;
}

/** 承認者マスタ（有効な approver ロールの利用者）。表示名とメールをユーザー表から解決する。 */
export async function listApprovers(): Promise<ApproverEntry[]> {
  const { rows } = await query<{
    id: string;
    display_name: string;
    email: string;
    dept_code: string;
  }>(
    `select u.id, u.display_name, u.email, u.dept_code
       from app_user u
       join user_role r on r.user_id = u.id and r.role = 'approver'
      where u.is_active
      order by u.display_name, u.created_at`,
  );
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    deptCode: row.dept_code,
  }));
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  deptCode: string;
  password: string;
  roles: Role[];
  isAdmin?: boolean;
}

/** 利用者を作る（scrypt）。作成は監査に actor と結果を残す。 */
export async function createUser(input: CreateUserInput, actor: UserCreationActor, correlationId: string): Promise<ManagedUser> {
  requireAdmin(actor);
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  const deptCode = input.deptCode.trim();
  const roles = normalizeRoles(input.roles);
  const denyAudit = (reason: string): Promise<unknown> =>
    appendAudit({
      action: 'user.create',
      targetType: 'user',
      targetId: email,
      result: 'denied',
      actorUserId: actor.userId,
      actorName: actor.displayName,
      role: actor.role,
      diff: userAdminDiff(actor, { email, reason }),
      correlationId,
    }).catch(() => undefined);

  if (roles.length === 0) {
    await denyAudit('roles_required');
    throw invalidUserField('ロールを1つ以上選んでください', 'roles');
  }
  const policyError = passwordPolicyError(input.password, email);
  if (policyError) {
    await denyAudit('password_policy');
    throw invalidUserField(policyError, 'password');
  }

  let outcome: { id: string } | { error: ApiError };
  try {
    outcome = await withTransaction(async (client) => {
      const duplicate = await client.query('select 1 from app_user where email = $1', [email]);
      if (duplicate.rowCount) {
        await auditUserAdmin(client, actor, 'user.create', email, 'denied', { email, reason: 'duplicate' }, correlationId);
        return { error: duplicateEmailError() };
      }
      const dept = await client.query('select 1 from department where code = $1', [deptCode]);
      if (!dept.rowCount) {
        await auditUserAdmin(
          client,
          actor,
          'user.create',
          email,
          'denied',
          { email, reason: 'dept_not_found', deptCode },
          correlationId,
        );
        return { error: Errors.notAllowedValue('deptCode') };
      }
      const hash = await hashPassword(input.password);
      const inserted = await client.query<{ id: string }>(
        `insert into app_user (email, display_name, dept_code, password_hash, is_admin)
         values ($1,$2,$3,$4,$5) returning id`,
        [email, displayName, deptCode, hash, input.isAdmin === true],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw Errors.internal();
      for (const role of roles) {
        await client.query('insert into user_role (user_id, role, granted_by) values ($1,$2,$3)', [id, role, actor.userId]);
      }
      await auditUserAdmin(
        client,
        actor,
        'user.create',
        id,
        'success',
        { email, displayName, deptCode, roles, isAdmin: input.isAdmin === true },
        correlationId,
      );
      return { id };
    });
  } catch (err) {
    // 同時に同じメールで作られた場合（事前確認をすり抜けた競合）。監査を残して同じ断り方にする。
    if (isUniqueViolation(err)) {
      await appendAudit({
        action: 'user.create',
        targetType: 'user',
        targetId: email,
        result: 'denied',
        actorUserId: actor.userId,
        actorName: actor.displayName,
        role: actor.role,
        diff: userAdminDiff(actor, { email, reason: 'duplicate_race' }),
        correlationId,
      }).catch(() => undefined);
      throw duplicateEmailError();
    }
    throw err;
  }

  if ('error' in outcome) throw outcome.error;
  const created = await getManagedUser(outcome.id);
  if (!created) throw Errors.internal();
  return created;
}

/** ロールを付け替える（依頼者・受付担当・承認者の3役だけ）。監査に actor と前後の値を残す。 */
export async function setUserRoles(
  userId: string,
  rolesInput: readonly string[],
  actor: AdminActor,
  correlationId: string,
): Promise<ManagedUser> {
  requireAdmin(actor);
  const roles = normalizeRoles(rolesInput);
  if (roles.length === 0) throw invalidUserField('ロールを1つ以上選んでください', 'roles');

  const outcome = await withTransaction(async (client) => {
    const found = await client.query<{ email: string }>('select email from app_user where id = $1 for update', [userId]);
    const row = found.rows[0];
    if (!row) {
      await auditUserAdmin(client, actor, 'user.roles', userId, 'denied', { reason: 'not_found' }, correlationId);
      return { error: Errors.notFound('利用者') };
    }
    const before = normalizeRoles(
      (await client.query<{ role: Role }>('select role from user_role where user_id = $1', [userId])).rows.map((r) => r.role),
    );
    // 残すロールは消さない（付与日時を保つ）。
    await client.query('delete from user_role where user_id = $1 and role <> all($2::text[])', [userId, roles]);
    for (const role of roles) {
      await client.query(
        'insert into user_role (user_id, role, granted_by) values ($1,$2,$3) on conflict (user_id, role) do nothing',
        [userId, role, actor.userId],
      );
    }
    await auditUserAdmin(
      client,
      actor,
      'user.roles',
      userId,
      'success',
      { email: row.email, before, after: roles },
      correlationId,
    );
    return { ok: true as const };
  });

  if ('error' in outcome) throw outcome.error;
  const updated = await getManagedUser(userId);
  if (!updated) throw Errors.internal();
  return updated;
}

/** パスワードを変える（scrypt）。変更後はその利用者のセッションを失効させる。値は監査に残さない。 */
export async function setUserPassword(
  userId: string,
  password: string,
  actor: AdminActor,
  correlationId: string,
): Promise<ManagedUser> {
  requireAdmin(actor);
  const outcome = await withTransaction(async (client) => {
    const found = await client.query<{ email: string }>('select email from app_user where id = $1 for update', [userId]);
    const row = found.rows[0];
    if (!row) {
      await auditUserAdmin(client, actor, 'user.password', userId, 'denied', { reason: 'not_found' }, correlationId);
      return { error: Errors.notFound('利用者') };
    }
    const policyError = passwordPolicyError(password, row.email);
    if (policyError) {
      await auditUserAdmin(
        client,
        actor,
        'user.password',
        userId,
        'denied',
        { email: row.email, reason: 'policy' },
        correlationId,
      );
      return { error: invalidUserField(policyError, 'password') };
    }
    const hash = await hashPassword(password);
    await client.query('update app_user set password_hash = $2, password_changed_at = now(), updated_at = now() where id = $1', [
      userId,
      hash,
    ]);
    const revoked = await client.query('delete from session where user_id = $1', [userId]);
    await auditUserAdmin(
      client,
      actor,
      'user.password',
      userId,
      'success',
      { email: row.email, sessionsRevoked: revoked.rowCount ?? 0 },
      correlationId,
    );
    return { ok: true as const };
  });

  if ('error' in outcome) throw outcome.error;
  const updated = await getManagedUser(userId);
  if (!updated) throw Errors.internal();
  return updated;
}

/** 有効・無効を切り替える。無効化はセッションも消し、最後の管理者と自分自身は無効化できない。 */
export async function setUserActive(
  userId: string,
  isActive: boolean,
  actor: AdminActor,
  correlationId: string,
): Promise<ManagedUser> {
  requireAdmin(actor);
  if (!isActive && userId === actor.userId) {
    await withTransaction(async (client) => {
      await auditUserAdmin(client, actor, 'user.deactivate', userId, 'denied', { reason: 'self' }, correlationId);
    });
    throw invalidUserField('自分自身は無効化できません', 'isActive');
  }

  const outcome = await withTransaction(async (client) => {
    const found = await client.query<{ email: string; is_admin: boolean; is_active: boolean }>(
      'select email, is_admin, is_active from app_user where id = $1 for update',
      [userId],
    );
    const row = found.rows[0];
    if (!row) {
      await auditUserAdmin(
        client,
        actor,
        isActive ? 'user.activate' : 'user.deactivate',
        userId,
        'denied',
        { reason: 'not_found' },
        correlationId,
      );
      return { error: Errors.notFound('利用者') };
    }

    if (isActive) {
      await client.query(
        'update app_user set is_active = true, deactivated_at = null, deactivated_by = null, updated_at = now() where id = $1',
        [userId],
      );
      await auditUserAdmin(client, actor, 'user.activate', userId, 'success', { email: row.email }, correlationId);
      return { ok: true as const };
    }

    if (!row.is_active) {
      await auditUserAdmin(
        client,
        actor,
        'user.deactivate',
        userId,
        'success',
        { email: row.email, alreadyInactive: true, sessionsRevoked: 0 },
        correlationId,
      );
      return { ok: true as const };
    }
    if (row.is_admin) {
      const others = await client.query<{ count: number }>(
        'select count(*)::int as count from app_user where is_admin and is_active and id <> $1',
        [userId],
      );
      if ((others.rows[0]?.count ?? 0) === 0) {
        await auditUserAdmin(
          client,
          actor,
          'user.deactivate',
          userId,
          'denied',
          { email: row.email, reason: 'last_admin' },
          correlationId,
        );
        return { error: invalidUserField('最後の管理者は無効化できません', 'isActive') };
      }
    }
    await client.query(
      'update app_user set is_active = false, deactivated_at = now(), deactivated_by = $2, updated_at = now() where id = $1',
      [userId, actor.userId],
    );
    const revoked = await client.query('delete from session where user_id = $1', [userId]);
    await auditUserAdmin(
      client,
      actor,
      'user.deactivate',
      userId,
      'success',
      { email: row.email, sessionsRevoked: revoked.rowCount ?? 0 },
      correlationId,
    );
    return { ok: true as const };
  });

  if ('error' in outcome) throw outcome.error;
  const updated = await getManagedUser(userId);
  if (!updated) throw Errors.internal();
  return updated;
}
