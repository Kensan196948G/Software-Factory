import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { versionAssets } from './asset-version.js';
import { authHealthStatus, config, isAccessJwtEnabled, type AuthHealthStatus } from './config.js';
import { ApiError, Errors, applySecurityHeaders, correlationId, sendError } from './http.js';
import { ZodError, z } from 'zod';
import { countActiveUsers, healthCheck } from './db.js';
import {
  CSRF_COOKIE,
  accessLogin,
  createUser,
  getManagedUser,
  listApprovers,
  listManagedUsers,
  resolveAccessIdentity,
  checkLoginRate,
  clearSessionCookies,
  login,
  logout,
  requireAuth,
  resolveSession,
  setSessionCookies,
  setUserActive,
  setUserPassword,
  setUserRoles,
  switchRole,
  verifyCsrf,
  type AdminActor,
  type AuthContext,
} from './auth.js';
import {
  actorOf,
  addComment,
  handoffToGithub,
  createDraftItem,
  createRequest,
  deleteAllDrafts,
  deleteDraftItem,
  exportAll,
  getDetail,
  getBootData,
  getOpsState,
  saveOpsState,
  getOrder,
  homeFor,
  listDrafts,
  importAll,
  listForActor,
  performTransition,
  resetDemo,
  updateDraftItem,
  updateRequest,
} from './service.js';
import { getCatalogTools, listDepartments } from './repo.js';
import { deliverOutboxMail, deliverPendingMail, enqueueStallReminders, listOutbox, mailSummary } from './mail-outbox.js';
import { verifyAuditChain, appendAudit } from './audit.js';
import {
  commentSchema,
  draftSchema,
  importSchema,
  jobOperationSchema,
  loginSchema,
  orderHandoffSchema,
  requestInputSchema,
  roleSchema,
  targetRepoSchema,
  transitionSchema,
} from './schemas.js';
import { listTargetRepos, readTargetRepoInput, setRequestTargetRepo } from './devline-target.js';
import { staleDays } from '../shared/domain.js';
import {
  cancelJob,
  getJob,
  handoffOrder,
  listDevlineTrace,
  listJobsForRequest,
  resumeJob,
  type DevlineDeps,
} from './devline-service.js';
import {
  approveDeploy,
  approveMerge,
  revokeMergeApproval,
  devlineSummary,
  listReleaseEvidence,
  rollbackRelease,
  type ReleaseDeps,
} from './devline-release.js';
import { approveDeploySchema, approveMergeSchema, revokeApprovalSchema, rollbackSchema } from './devline-release-schemas.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/** 承認依頼メールの状態（クエリ検証に使う）。 */
const MAIL_STATES = ['pending', 'sending', 'sent', 'failed'] as const;

/** 未ログインの /api/meta に出す従来の承認者一覧（実在の利用者のメールを公開しないための後方互換）。 */
const LEGACY_APPROVERS = [
  { name: '鈴木 一郎', email: 'suzuki@example.com' },
  { name: '田中 誠司', email: 'tanaka@example.com' },
  { name: '松本 綾', email: 'matsumoto@example.com' },
];

const managedRolesSchema = z.array(z.enum(['requester', 'desk', 'approver'])).min(1).max(3);

const adminUserCreateSchema = z.object({
  email: z.string().trim().email().max(200),
  displayName: z.string().trim().min(1).max(80),
  deptCode: z.string().trim().min(1).max(20),
  password: z.string().min(1).max(200),
  roles: managedRolesSchema,
  isAdmin: z.boolean().optional(),
});

const adminUserPatchSchema = z
  .object({
    isActive: z.boolean().optional(),
    roles: managedRolesSchema.optional(),
    password: z.string().min(1).max(200).optional(),
  })
  .refine((value) => value.isActive !== undefined || value.roles !== undefined || value.password !== undefined, {
    message: '変更する項目がありません',
  });

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 依頼の作成・更新で、承認者をユーザーIDで指定する任意の入力（後方互換のため名前だけでもよい）。 */
function approverUserIdOf(req: FastifyRequest): string | undefined {
  const raw = (req.body as { approverUserId?: unknown } | undefined)?.approverUserId;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) throw Errors.notAllowedValue('approverUserId');
  return raw;
}

function adminActorOf(ctx: AuthContext): AdminActor {
  return {
    userId: ctx.user.id,
    displayName: ctx.user.displayName,
    role: ctx.user.actingRole,
    isAdmin: ctx.user.isAdmin,
  };
}

export async function buildApp(
  opts: { serveStatic?: boolean; devlineDeps?: DevlineDeps; releaseDeps?: ReleaseDeps } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.nodeEnv === 'test' && process.env.DEBUG_TEST !== '1'
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            redact: [
              'req.headers.cookie',
              'req.headers.authorization',
              'req.headers["x-csrf-token"]',
              'req.headers["cf-access-jwt-assertion"]',
            ],
          },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: config.nodeEnv === 'test',
  });

  await app.register(cookie, {});

  // 本番なのに自己承認を明示的に許可している場合は、起動時に一度だけ監査へ警告を残す。
  if (config.selfApprovalForcedInProduction) {
    app.addHook('onReady', async () => {
      await appendAudit({
        action: 'config.self_approval_enabled',
        targetType: 'system',
        targetId: null,
        result: 'success',
        actorName: 'system',
        role: 'system',
        diff: {
          warning: 'APP_ENV=production で ALLOW_SELF_APPROVAL=1 を明示している（職務分離が弱まる）',
          appEnv: config.appEnv,
        },
      }).catch(() => undefined);
    });
  }

  app.addHook('onRequest', async (req, reply) => {
    applySecurityHeaders(reply);
    const cid = correlationId(req);
    reply.header('X-Correlation-Id', cid);
    // Cloudflare Worker 経由であることの確認（本番のみ）
    if (config.requireOriginSecret) {
      const header = req.headers['x-origin-secret'];
      const isHealth = req.url === '/healthz' || req.url === '/readyz';
      if (!isHealth && (typeof header !== 'string' || header !== config.originSharedSecret)) {
        throw new ApiError('ERR-101', 'この操作をする権限がありません', 403);
      }
    }
    let ctx = await resolveSession(req);
    // JWT 検証が有効なら毎回検証する（Cookie だけでは通さない。別人の JWT が来たらセッションも使わない）
    const jwtRequired = isAccessJwtEnabled(config);
    if (config.authMode === 'access' && (!ctx || jwtRequired)) {
      const identity = await resolveAccessIdentity(req.headers, req.log);
      if (jwtRequired && ctx && ctx.user.email.toLowerCase() !== identity) ctx = null;
      if (!ctx && identity) {
        try {
          const result = await accessLogin(identity, req.ip);
          setSessionCookies(reply, result.token, result.csrf, result.expiresAt);
          ctx = result.ctx;
        } catch {
          ctx = null;
        }
      }
    }
    req.auth = ctx;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    const cid = correlationId(req);
    if (err instanceof ApiError) {
      sendError(reply, err, cid);
      return;
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const message = issue?.message ?? '入力の形が正しくありません';
      const code = message.includes('8件')
        ? 'ERR-006'
        : message.includes('文字数') || message.includes('60文字')
          ? 'ERR-002'
          : 'ERR-001';
      sendError(reply, new ApiError(code, message, 400, { path: issue?.path, issues: err.issues }), cid);
      return;
    }
    // @fastify/static は正規形でないパス（// や /./ など）を 403 で拒否する。存在しないパスと同じ扱いにする。
    if ((err as { statusCode?: number }).statusCode === 403 && req.routeOptions.url === '/*') {
      void reply.callNotFound();
      return;
    }
    if ((err as { statusCode?: number }).statusCode === 400) {
      sendError(reply, Errors.shape(), cid);
      return;
    }
    req.log.error({ err, cid }, 'unhandled error');
    sendError(reply, Errors.internal(undefined, cid), cid);
  });

  function auth(req: FastifyRequest): AuthContext {
    return requireAuth(req.auth);
  }

  function mutate(req: FastifyRequest): AuthContext {
    const ctx = auth(req);
    verifyCsrf(req, ctx);
    return ctx;
  }

  /* ───────── health ───────── */
  app.get('/healthz', async () => {
    const db = await healthCheck();
    const auth: AuthHealthStatus = authHealthStatus(config);
    // 有効な利用者 0 件は「構成は ready なのに全員 401」になる（docs/limitations.md C-07）。
    // 返すのは件数だけで、メール・ID・名前は返さない。
    // 取得できなかったときは null を明示する（キー欠如＝旧 API の版ずれと区別し、監視を fail-closed にする）。
    if (db.ok) {
      try {
        auth.usersActive = await countActiveUsers();
      } catch {
        auth.usersActive = null;
      }
    }
    return {
      status: db.ok ? 'ok' : 'degraded',
      app: 'mirai-sf-intake',
      version: config.appVersion,
      commit: config.commitSha,
      environment: config.appEnv,
      db: db.ok ? { ok: true, latencyMs: db.latencyMs } : { ok: false, error: db.error },
      // 認証不能（401 が続く状態）を外形監視で検知するための追加情報。秘密の値は返さない。
      auth,
      now: new Date().toISOString(),
    };
  });

  app.get('/readyz', async (_req, reply) => {
    const db = await healthCheck();
    if (!db.ok) {
      void reply.status(503).send({ status: 'not_ready', db });
      return;
    }
    void reply.send({ status: 'ready', db });
  });

  /* ───────── auth ───────── */
  app.post('/api/auth/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);
    checkLoginRate(req.ip);
    try {
      const result = await login(body.email, body.password, req.ip);
      setSessionCookies(reply, result.token, result.csrf, result.expiresAt);
      return { user: result.user, csrf: result.csrf };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw Errors.sessionExpired();
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const ctx = mutate(req);
    await logout(ctx);
    clearSessionCookies(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const ctx = req.auth;
    if (!ctx) throw Errors.sessionExpired();
    return { user: ctx.user };
  });

  app.post('/api/auth/role', async (req) => {
    const ctx = mutate(req);
    const body = roleSchema.parse(req.body);
    await switchRole(ctx, body.role);
    return { user: ctx.user };
  });

  /* ───────── meta ───────── */
  // 未ログインには実在の利用者のメールを出さない。ログイン時は承認者マスタを返す。
  // 本番以外は、見本データの承認者名（従来の固定一覧）も後方互換で残す。
  app.get('/api/meta', async (req) => {
    const directory = req.auth ? await listApprovers() : [];
    const master = directory.map((a) => ({ id: a.id, name: a.displayName, email: a.email }));
    const approvers = config.isProduction
      ? master
      : [...master, ...LEGACY_APPROVERS.filter((legacy) => !master.some((m) => m.name === legacy.name || m.email === legacy.email))];
    return {
      appName: 'みらいSF 受付ステーション',
      version: config.appVersion,
      commit: config.commitSha,
      environment: config.appEnv,
      now: new Date().toISOString(),
      staleWarnDays: 3,
      staleDangerDays: 7,
      allowSelfApproval: config.allowSelfApproval,
      selfApprovalForcedInProduction: config.selfApprovalForcedInProduction,
      allowImport: config.allowImport,
      authMode: config.authMode,
      githubConfigured: Boolean(config.githubToken),
      approvers,
    };
  });

  /* ───────── 承認者マスタ（有効な approver ロールの利用者） ───────── */
  app.get('/api/approvers', async (req) => {
    auth(req);
    return { items: await listApprovers() };
  });

  /* ───────── home / requests ───────── */
  app.get('/api/home', async (req) => homeFor(actorOf(auth(req).user)));

  app.get('/api/requests', async (req) => {
    const ctx = auth(req);
    const q = req.query as Record<string, string | undefined>;
    return listForActor(actorOf(ctx.user), {
      q: q.q,
      dept: q.dept,
      status: q.status,
      signal: q.signal,
      mine: q.mine === '1' || q.mine === 'true',
      includeDeleted: q.includeDeleted === '1',
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 50,
    });
  });

  app.post('/api/requests', async (req, reply) => {
    const ctx = mutate(req);
    const body = requestInputSchema.parse(req.body);
    // 投入先（L-12）。画面の値を信じず、サーバが台帳と設定の積集合で決め直す（外れていれば ERR-405）
    const target = readTargetRepoInput(req.body, opts.devlineDeps);
    if (target.provided) body.targetRepoId = target.value;
    const key = req.headers['idempotency-key'];
    void reply.status(201);
    const detail = await createRequest(
      body,
      actorOf(ctx.user),
      correlationId(req),
      typeof key === 'string' ? key : undefined,
      approverUserIdOf(req),
    );
    return { request: detail };
  });

  app.get('/api/requests/:id', async (req) => {
    const ctx = auth(req);
    const { id } = req.params as { id: string };
    return { request: await getDetail(id, actorOf(ctx.user)) };
  });

  app.patch('/api/requests/:id', async (req) => {
    const ctx = mutate(req);
    const { id } = req.params as { id: string };
    const body = requestInputSchema.parse(req.body);
    const version = Number((req.body as { version?: number }).version);
    if (!Number.isInteger(version) || version < 1) throw Errors.shape('version');
    // 投入先（L-12）は内容の更新では変えない。service 側で「変化する指定」を ERR-004 にする
    // （変更は `PATCH /api/requests/:id/devline-target` だけ。食い違いを作れないようにする一本化）。
    return updateRequest(id, body, actorOf(ctx.user), version, correlationId(req), approverUserIdOf(req));
  });

  /* 依頼の投入先の変更（L-12）。内容の編集ではないので版と承認を動かさない（監査には残す） */
  app.patch('/api/requests/:id/devline-target', async (req) => {
    const ctx = mutate(req);
    const { id } = req.params as { id: string };
    const body = targetRepoSchema.parse(req.body ?? {});
    const targetRepo = await setRequestTargetRepo(
      { requestId: id, targetRepoId: body.targetRepoId },
      actorOf(ctx.user),
      correlationId(req),
      opts.devlineDeps,
    );
    return { targetRepo };
  });

  app.post('/api/requests/:id/transitions', async (req) => {
    const ctx = mutate(req);
    const { id } = req.params as { id: string };
    const body = transitionSchema.parse(req.body);
    return performTransition(id, body, actorOf(ctx.user), correlationId(req));
  });

  app.post('/api/requests/:id/comments', async (req) => {
    const ctx = mutate(req);
    const { id } = req.params as { id: string };
    const body = commentSchema.parse(req.body);
    return addComment(id, body.text, actorOf(ctx.user), correlationId(req));
  });

  app.post('/api/requests/:id/handoff', async (req) => {
    const ctx = mutate(req);
    const { id } = req.params as { id: string };
    return handoffToGithub(id, actorOf(ctx.user), correlationId(req), opts.devlineDeps);
  });

  /* ───────── 開発ライン（API-06・ジョブ）。API-07 は別の Approval PR なので作らない ───────── */
  app.post('/api/orders/:id/handoff', async (req) => {
    const ctx = mutate(req);
    const { id } = req.params as { id: string };
    const body = orderHandoffSchema.parse(req.body);
    return handoffOrder(
      {
        requestId: id,
        orderVersion: body.orderVersion,
        ...(body.confirmAbsent ? { confirmAbsent: { reason: body.reason ?? '' } } : {}),
      },
      actorOf(ctx.user),
      correlationId(req),
      opts.devlineDeps,
    );
  });

  app.get('/api/jobs/:id', async (req) => {
    const ctx = auth(req);
    const { id } = req.params as { id: string };
    return { job: await getJob(id, actorOf(ctx.user)) };
  });

  app.get('/api/requests/:id/jobs', async (req) => {
    const ctx = auth(req);
    const { id } = req.params as { id: string };
    const items = await listJobsForRequest(id, actorOf(ctx.user));
    return { items, ...(await listDevlineTrace(id, opts.devlineDeps)), release: await listReleaseEvidence(id) };
  });

  /* ───────── 人の承認 → merge → 検証環境への配備 → 戻し（仕様 4-9）。repo・イメージ・ポートはブラウザから受けない ───────── */
  app.post('/api/jobs/:id/approve-merge', async (req) => {
    const ctx = mutate(req);
    const { id } = req.params as { id: string };
    const body = approveMergeSchema.parse(req.body);
    return approveMerge(
      { jobId: id, headSha: body.headSha, ...(body.reconcileOnly ? { reconcileOnly: true } : {}) },
      actorOf(ctx.user),
      correlationId(req),
      opts.releaseDeps,
    );
  });

  app.post('/api/jobs/:id/revoke-approval', async (req) => {
    const ctx = mutate(req);
    const { id } = req.params as { id: string };
    const body = revokeApprovalSchema.parse(req.body);
    return revokeMergeApproval({ jobId: id, ...body }, actorOf(ctx.user), correlationId(req), new Date());
  });

  app.post('/api/jobs/:id/approve-deploy', async (req) => {
    const ctx = mutate(req);
    const { id } = req.params as { id: string };
    const body = approveDeploySchema.parse(req.body);
    return approveDeploy({ jobId: id, ...body }, actorOf(ctx.user), correlationId(req), new Date());
  });

  app.post('/api/jobs/:id/rollback', async (req) => {
    const ctx = mutate(req);
    const { id } = req.params as { id: string };
    const body = rollbackSchema.parse(req.body);
    return rollbackRelease({ jobId: id, reason: body.reason }, actorOf(ctx.user), correlationId(req), new Date());
  });

  app.get('/api/devline/summary', async (req) => {
    auth(req);
    return devlineSummary();
  });

  /* 依頼ごとの投入先の候補（L-12）。設定と許可台帳の積集合だけで、値はサーバが決める */
  app.get('/api/devline/target-repos', async (req) => {
    auth(req);
    return listTargetRepos(opts.devlineDeps);
  });

  app.post('/api/jobs/:id/cancel', async (req) => {
    const ctx = mutate(req);
    const { id } = req.params as { id: string };
    const body = jobOperationSchema.parse(req.body ?? {});
    const job = await cancelJob({ jobId: id, ...body }, actorOf(ctx.user), correlationId(req), new Date());
    return { job };
  });

  app.post('/api/jobs/:id/resume', async (req) => {
    const ctx = mutate(req);
    const { id } = req.params as { id: string };
    const body = jobOperationSchema.parse(req.body ?? {});
    const job = await resumeJob({ jobId: id, ...body }, actorOf(ctx.user), correlationId(req), new Date());
    return { job };
  });

  app.get('/api/requests/:id/order', async (req) => {
    const ctx = auth(req);
    const { id } = req.params as { id: string };
    return getOrder(id, actorOf(ctx.user));
  });

  /* ───────── catalog ───────── */
  app.get('/api/catalog/departments', async (req) => {
    auth(req);
    return { items: await listDepartments() };
  });

  app.get('/api/catalog/tools', async (req) => {
    auth(req);
    const q = req.query as Record<string, string | undefined>;
    return { items: await getCatalogTools({ dept: q.dept, signal: q.signal, q: q.q }) };
  });

  app.get('/api/catalog/summary', async (req) => {
    auth(req);
    const departments = await listDepartments();
    return {
      departments: departments.length,
      tools: departments.reduce((sum, d) => sum + d.toolCount, 0),
      g: departments.reduce((sum, d) => sum + d.g, 0),
      y: departments.reduce((sum, d) => sum + d.y, 0),
      r: departments.reduce((sum, d) => sum + d.r, 0),
    };
  });

  /* ───────── draft ───────── */
  /* ───────── 下書き（利用者ごとに複数件） ───────── */
  app.get('/api/drafts', async (req) => {
    const ctx = auth(req);
    return listDrafts(ctx.user.id);
  });

  app.post('/api/drafts', async (req) => {
    const ctx = mutate(req);
    const body = draftSchema.parse(req.body);
    return { draft: await createDraftItem(ctx.user.id, body.draft, body.step, body.editId ?? null) };
  });

  app.put('/api/drafts/:id', async (req) => {
    const ctx = mutate(req);
    const body = draftSchema.parse(req.body);
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw Errors.notFound('下書き');
    return { draft: await updateDraftItem(ctx.user.id, id, body.draft, body.step, body.editId ?? null) };
  });

  app.delete('/api/drafts/:id', async (req) => {
    const ctx = mutate(req);
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: true };
    return deleteDraftItem(ctx.user.id, id);
  });

  app.delete('/api/drafts', async (req) => {
    const ctx = mutate(req);
    return deleteAllDrafts(ctx.user.id);
  });

  /* ───────── export / import ───────── */
  app.get('/api/export.json', async (req, reply) => {
    const ctx = auth(req);
    const data = await exportAll(actorOf(ctx.user));
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="mirai-sf-requests-${stamp()}.json"`);
    return data.json;
  });

  app.get('/api/export.csv', async (req, reply) => {
    const ctx = auth(req);
    const data = await exportAll(actorOf(ctx.user));
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="mirai-sf-requests-${stamp()}.csv"`);
    return data.csv;
  });

  app.post('/api/import', async (req) => {
    const ctx = mutate(req);
    if (ctx.user.actingRole !== 'approver' && !ctx.user.isAdmin) throw Errors.noPermission();
    const body = importSchema.parse(req.body);
    return importAll(body as { items: Record<string, unknown>[]; seq?: number }, actorOf(ctx.user), correlationId(req));
  });

  /* ───────── audit ───────── */
  app.get('/api/audit-logs', async (req) => {
    const ctx = auth(req);
    if (!ctx.user.isAdmin) throw Errors.noPermission();
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(q.limit ?? 100), 500);
    const rows = await (
      await import('./db.js')
    ).many<{
      id: number;
      at: Date;
      actor_name: string;
      role: string;
      action: string;
      target_type: string;
      target_id: string | null;
      result: string;
      correlation_id: string | null;
      hash: string;
    }>(
      'select id, at, actor_name, role, action, target_type, target_id, result, correlation_id, hash from audit_log order by id desc limit $1',
      [limit],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        actor: r.actor_name,
        role: r.role,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        result: r.result,
        correlationId: r.correlation_id,
        hash: r.hash,
      })),
      chain: await verifyAuditChain(),
    };
  });

  // 監査ログのCSV（管理者）。監査の証跡をそのまま持ち出せるようにする。
  app.get('/api/audit-logs.csv', async (req, reply) => {
    const ctx = auth(req);
    if (!ctx.user.isAdmin) throw Errors.noPermission();
    const rows = await (
      await import('./db.js')
    ).many<{
      id: number;
      at: Date;
      actor_name: string | null;
      role: string;
      action: string;
      target_type: string;
      target_id: string | null;
      result: string;
      correlation_id: string | null;
      hash: string;
    }>(
      'select id, at, actor_name, role, action, target_type, target_id, result, correlation_id, hash from audit_log order by id desc limit 5000',
    );
    const cell = (v: unknown): string => {
      const text = v === null || v === undefined ? '' : String(v);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const header = ['id', 'at', 'actor_name', 'role', 'action', 'target_type', 'target_id', 'result', 'correlation_id', 'hash'];
    const lines = rows.map((r) =>
      [
        r.id,
        r.at.toISOString(),
        r.actor_name ?? '',
        r.role,
        r.action,
        r.target_type,
        r.target_id ?? '',
        r.result,
        r.correlation_id ?? '',
        r.hash,
      ]
        .map(cell)
        .join(','),
    );
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="audit-logs-${stamp()}.csv"`);
    return '\uFEFF' + [header.join(','), ...lines].join('\r\n') + '\r\n';
  });

  /* ───────── admin（開発・検証用） ───────── */
  // 利用者管理（職務分離のための複数ユーザー）。管理者だけが操作でき、すべて監査に残す。
  app.get('/api/admin/users', async (req) => {
    const ctx = auth(req);
    if (!ctx.user.isAdmin) throw Errors.noPermission();
    return { items: await listManagedUsers() };
  });

  app.post('/api/admin/users', async (req, reply) => {
    const ctx = mutate(req);
    if (!ctx.user.isAdmin) throw Errors.noPermission();
    const body = adminUserCreateSchema.parse(req.body);
    const user = await createUser(
      {
        email: body.email,
        displayName: body.displayName,
        deptCode: body.deptCode,
        password: body.password,
        roles: body.roles,
        isAdmin: body.isAdmin,
      },
      adminActorOf(ctx),
      correlationId(req),
    );
    void reply.status(201);
    return { user };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const ctx = mutate(req);
    if (!ctx.user.isAdmin) throw Errors.noPermission();
    const userId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(userId)) throw Errors.notFound('利用者');
    const body = adminUserPatchSchema.parse(req.body);
    const actor = adminActorOf(ctx);
    const cid = correlationId(req);
    // パスワード → ロール → 有効/無効の順。どの操作も個別に監査へ残す。
    if (body.password !== undefined) await setUserPassword(userId, body.password, actor, cid);
    if (body.roles !== undefined) await setUserRoles(userId, body.roles, actor, cid);
    if (body.isActive !== undefined) await setUserActive(userId, body.isActive, actor, cid);
    const user = await getManagedUser(userId);
    if (!user) throw Errors.notFound('利用者');
    return { user };
  });

  app.post('/api/admin/reset-demo', async (req) => {
    const ctx = mutate(req);
    if (!ctx.user.isAdmin || config.isProduction) throw Errors.noPermission();
    return resetDemo(actorOf(ctx.user), correlationId(req));
  });

  app.get('/api/admin/stats', async (req) => {
    const ctx = auth(req);
    if (!ctx.user.isAdmin) throw Errors.noPermission();
    const db = await import('./db.js');
    const counts = await db.many<{ status: string; count: number }>(
      'select status, count(*)::int as count from request where deleted=false group by status',
    );
    const stale = await db.many<{ id: string; updated_at: Date }>(
      `select r.id, r.updated_at from request r where r.deleted=false and r.status not in ('done','hold','cancel')`,
    );
    return {
      byStatus: counts,
      stale3: stale.filter((s) => staleDays(s.updated_at) >= 3).length,
    };
  });

  /* ───────── 画面（コンソール原本 + 起動データ） ───────── */
  const webDist = resolve(process.cwd(), 'dist/web');
  const appHtmlPath = resolve(webDist, 'index.html');

  function renderAppHtml(ctx: AuthContext, boot: unknown): string | null {
    if (!existsSync(appHtmlPath)) return null;
    const template = versionAssets(readFileSync(appHtmlPath, 'utf8'), config.commitSha);
    const json = JSON.stringify(boot).replace(/</g, '\\u003c');
    return template.replace('<!--MSF_BOOT-->', `<script type="application/json" id="msf-boot">${json}</script>`);
  }

  app.get('/', async (req, reply) => {
    const ctx = req.auth;
    if (!ctx) {
      if (config.authMode === 'access') {
        void reply
          .status(401)
          .type('text/html')
          .send('<p>認証できませんでした。Cloudflare Access の設定を確認してください。</p>');
        return;
      }
      void reply.redirect('/login');
      return;
    }
    const data = await getBootData(ctx.user.id);
    const html = renderAppHtml(ctx, {
      user: ctx.user,
      role: ctx.user.actingRole,
      csrf: ctx.session.csrf_token,
      seq: data.seq,
      items: data.items,
      drafts: data.drafts,
      ops: data.ops,
      // Authenticated boot only; never fall back to the prototype's sample approvers.
      approvers: await listApprovers(),
    });
    if (!html) {
      void reply.status(503).type('text/plain').send('画面がビルドされていません（pnpm build）');
      return;
    }
    void reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/login', async (req, reply) => {
    if (req.auth) {
      void reply.redirect('/');
      return;
    }
    const loginPath = resolve(webDist, 'login.html');
    if (existsSync(loginPath)) {
      void reply.type('text/html; charset=utf-8').send(readFileSync(loginPath, 'utf8'));
      return;
    }
    void reply
      .type('text/html; charset=utf-8')
      .send('<!doctype html><meta charset="utf-8"><p>ログイン画面がありません（pnpm build）</p>');
  });

  /* ───────── static assets（index は上のルートで配信） ───────── */
  if (opts.serveStatic !== false && existsSync(webDist)) {
    // Cloudflare のエッジに毎回確認させる。ブラウザ向けは 4 時間に書き換えられるので、URL の版（versionAssets）で更新する
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      index: false,
      cacheControl: false,
      setHeaders: (reply) => {
        void reply.header('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url === '/healthz' || req.url === '/readyz') {
        void reply.status(404).send(Errors.notFound('API').toBody(correlationId(req)));
        return;
      }
      void reply.redirect('/');
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      void reply.status(404).send(Errors.notFound('API').toBody(correlationId(req)));
    });
  }

  // 起動時にクッキー名を公開（フロントの二重送信 CSRF 用）
  /* ───────── 運用・DevOps・SecOps の状態 ───────── */
  app.get('/api/ops', async (req) => {
    auth(req);
    const state = await getOpsState();
    return state ?? { data: null, version: 0 };
  });

  app.put('/api/ops', async (req) => {
    const ctx = mutate(req);
    // 運用・DevOps・SecOps は共有の状態。依頼者は書き換えられない。
    if (!ctx.user.isAdmin && !['desk', 'approver'].includes(ctx.user.actingRole)) throw Errors.noPermission();
    const body = req.body as { data?: unknown; version?: unknown };
    if (!body || body.data === undefined) throw Errors.required('data');
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 0) throw Errors.shape('version');
    return saveOpsState(body.data, version, actorOf(ctx.user), correlationId(req));
  });

  /* ───────── 承認依頼メール（outbox） ───────── */
  app.get('/api/mail/status', async (req) => {
    auth(req);
    return mailSummary();
  });

  app.get('/api/mail/outbox', async (req) => {
    const ctx = auth(req);
    if (!['desk', 'approver'].includes(ctx.user.actingRole) && !ctx.user.isAdmin) throw Errors.noPermission();
    const q = req.query as { status?: string; limit?: string };
    const status = q.status;
    if (status !== undefined && !MAIL_STATES.includes(status as (typeof MAIL_STATES)[number])) {
      throw Errors.notAllowedValue('status');
    }
    return listOutbox({
      ...(status ? { status: status as (typeof MAIL_STATES)[number] } : {}),
      limit: Number(q.limit ?? 20) || 20,
    });
  });

  // 送信失敗ぶんの再送（受付担当・管理者）。CSRF あり。
  app.post('/api/mail/outbox/:id/retry', async (req) => {
    const ctx = mutate(req);
    if (!ctx.user.isAdmin && ctx.user.actingRole !== 'desk') throw Errors.noPermission();
    const id = (req.params as { id: string }).id;
    if (!/^\d{1,18}$/.test(id)) throw Errors.notFound('送信できるメール');
    const result = await deliverOutboxMail(id, { force: true });
    if (!result) throw Errors.notFound('送信できるメール');
    return result;
  });

  app.post('/api/mail/flush', async (req) => {
    const ctx = mutate(req);
    if (!ctx.user.isAdmin) throw Errors.noPermission();
    return deliverPendingMail(20);
  });

  // 滞留通知（催促メール）。日次ジョブからも同じ処理を呼ぶ（scripts/reminders.ts）
  app.post('/api/mail/reminders', async (req) => {
    const ctx = mutate(req);
    if (!ctx.user.isAdmin) throw Errors.noPermission();
    const days = Number((req.body as { days?: unknown } | undefined)?.days ?? 3);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw Errors.shape('days');
    const result = await enqueueStallReminders({ days });
    const delivery = await deliverPendingMail(20);
    return { ...result, delivery };
  });

  app.get('/api/auth/csrf', async (req) => {
    const ctx = req.auth;
    return { csrf: ctx ? ctx.session.csrf_token : null, cookieName: CSRF_COOKIE };
  });

  return app;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export type { FastifyReply };
