import { randomBytes, createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import { config } from './config.js';
import { verifyPassword } from './password.js';
import { Errors } from './http.js';
import { appendAudit } from './audit.js';
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

  const roles: Role[] = row.roles.length > 0 ? row.roles : ['requester'];
  const actingRole: Role = roles.includes('desk') ? 'desk' : roles[0]!;
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);

  await query(
    `insert into session (id, user_id, acting_role, csrf_token, expires_at) values ($1,$2,$3,$4,$5)`,
    [hashToken(token), row.id, actingRole, csrf, expiresAt],
  );
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
  const roles: Role[] = found.roles.length > 0 ? found.roles : ['requester'];
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
    const allowed = new Set([config.appBaseUrl, ...(process.env.EXTRA_ORIGINS ?? '').split(',').filter(Boolean)]);
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
