import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../../src/api/auth.js';
import { verifyAuditChain } from '../../src/api/audit.js';
import { requestYearPrefix } from '../../src/shared/domain.js';
import { config } from '../../src/api/config.js';
import { query } from '../../src/api/db.js';
import {
  authHeaders,
  buildTestApp,
  loginAs,
  prepareTestDb,
  sampleRequest,
  TEST_USER,
  truncateBusiness,
} from './helpers.js';

const ORIGIN = 'http://127.0.0.1:8781';
let app: FastifyInstance;

function setCookiesOf(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

async function latestAuditId(): Promise<string> {
  const row = (await query<{ id: string }>('select id from audit_log order by id desc limit 1')).rows[0];
  if (!row) throw new Error('監査行がありません');
  return row.id;
}

beforeAll(async () => {
  await prepareTestDb();
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateBusiness();
});

describe('AUTH-01', () => {
  it('セッション Cookie は HttpOnly かつ SameSite=Lax', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: TEST_USER.email, password: TEST_USER.password },
    });

    expect(res.statusCode).toBe(200);
    const sessionCookie = setCookiesOf(res).find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/;\s*HttpOnly(?:;|$)/i);
    expect(sessionCookie).toMatch(/;\s*SameSite=Lax(?:;|$)/i);
  });

  it('ログイン失敗を login_failed として監査に残す', async () => {
    const clientIp = '198.51.100.11';
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: clientIp,
      payload: { email: TEST_USER.email, password: 'wrong-password' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ERR-106');
    const audits = await query<{
      actor_name: string;
      role: string;
      target_type: string;
      result: string;
      diff: unknown;
    }>("select actor_name, role, target_type, result, diff from audit_log where action = 'login_failed'");
    expect(audits.rows).toEqual([
      {
        actor_name: TEST_USER.email,
        role: 'system',
        target_type: 'session',
        result: 'denied',
        diff: { ip: clientIp },
      },
    ]);
  });
});

describe('AUTH-02', () => {
  it('CSRF トークンが一致しない更新系を 403 で拒否する', async () => {
    const auth = await loginAs(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/role',
      headers: { cookie: auth.cookie, 'x-csrf-token': `${auth.csrf}-mismatch`, origin: ORIGIN },
      payload: { role: 'requester' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ERR-101');
  });

  it('Origin が許可されていない更新系を 403 で拒否する', async () => {
    const auth = await loginAs(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/role',
      headers: { ...authHeaders(auth), origin: 'https://attacker.example' },
      payload: { role: 'requester' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ERR-101');
  });
});

describe('REQ-01', () => {
  it('受付番号は同じ年の連番になり、複数件でも一意になる', async () => {
    const auth = await loginAs(app);
    const create = (title: string) =>
      app.inject({
        method: 'POST',
        url: '/api/requests',
        headers: authHeaders(auth),
        payload: sampleRequest({ title }),
      });

    const responses = [
      await create('連番 1（作り物）'),
      await create('連番 2（作り物）'),
      await create('連番 3（作り物）'),
    ];
    for (const res of responses) expect(res.statusCode).toBe(201);
    const ids = responses.map((res) => res.json<{ request: { id: string } }>().request.id);

    const parsed = ids.map((id) => {
      const m = /^REQ-(\d{4})-(\d{4})$/.exec(id);
      if (!m) throw new Error(`形式が違います: ${id}`);
      return { year: m[1], seq: Number(m[2]) };
    });
    expect(new Set(parsed.map((p) => p.year)).size).toBe(1);
    expect(new Set(ids).size).toBe(ids.length);
    const [first, second, third] = parsed;
    if (!first || !second || !third) throw new Error('3 件そろっていません');
    expect(second.seq).toBe(first.seq + 1);
    expect(third.seq).toBe(second.seq + 1);
  });

  it('年跨ぎの接頭辞は REQ-<新年>- になる（DB 時計の制御が要るため書式のみ確認）', () => {
    expect(requestYearPrefix(2026)).toBe('REQ-2026-');
    expect(requestYearPrefix(2027)).toBe('REQ-2027-');
  });
});

describe('AUDIT-01', () => {
  it.each([
    ['UPDATE', "update audit_log set actor_name = '改ざん' where id = $1"],
    ['DELETE', 'delete from audit_log where id = $1'],
  ] as const)('audit_log の %s を DB が拒否する', async (_operation, sql) => {
    await loginAs(app);
    const id = await latestAuditId();
    await expect(query(sql, [id])).rejects.toThrow(/audit_log is append-only/);
  });

  it('ハッシュ連鎖検証が不正なハッシュ行を改ざんとして検知する', async () => {
    await loginAs(app);
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 1 });
    const lastHash = (await query<{ hash: string }>('select hash from audit_log order by id desc limit 1')).rows[0]?.hash;
    expect(lastHash).toBeDefined();

    const inserted = await query<{ id: string }>(
      `insert into audit_log
        (actor_user_id, actor_name, role, action, target_type, target_id, result, diff, correlation_id, prev_hash, hash)
       values (null, '改ざん者', 'system', 'tamper', 'audit_log', null, 'denied', $1, null, $2, $3)
       returning id`,
      [JSON.stringify({ tampered: true }), lastHash, '0'.repeat(64)],
    );
    const tamperedId = inserted.rows[0]?.id;
    expect(tamperedId).toBeDefined();

    const verification = await verifyAuditChain();
    expect(verification).toMatchObject({ ok: false, checked: 2 });
    expect(Number(verification.brokenAt)).toBe(Number(tamperedId));
  });
});

describe('RATE-01', () => {
  it('ログイン失敗は 10 回目まで 401、11 回目は 429 ERR-302', async () => {
    const originalNodeEnv = config.nodeEnv;
    const clientIp = '198.51.100.77';
    config.nodeEnv = 'development';
    try {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          remoteAddress: clientIp,
          payload: { email: TEST_USER.email, password: 'wrong-password' },
        });
        expect(res.statusCode, `${attempt} 回目`).toBe(401);
        expect(res.json<{ error: { code: string } }>().error.code, `${attempt} 回目`).toBe('ERR-106');
      }

      const blocked = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: clientIp,
        payload: { email: TEST_USER.email, password: 'wrong-password' },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json<{ error: { code: string } }>().error.code).toBe('ERR-302');
    } finally {
      config.nodeEnv = originalNodeEnv;
    }
  });
});
