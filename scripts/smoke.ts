/**
 * Preview / 本番相当の外形スモークテスト（読み取りのみ）。
 *
 * 使い方:
 *   BASE_URL=https://... SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm exec tsx scripts/smoke.ts
 *   BASE_URL=... ACCESS_CLIENT_ID=... ACCESS_CLIENT_SECRET=... ...（Cloudflare Access 配下の場合）
 */
const baseUrl = (process.env.BASE_URL ?? 'http://127.0.0.1:8781').replace(/\/$/, '');
const email = process.env.SMOKE_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? '';
const password = process.env.SMOKE_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? '';
const accessId = process.env.ACCESS_CLIENT_ID ?? '';
const accessSecret = process.env.ACCESS_CLIENT_SECRET ?? '';

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(accessId && accessSecret ? { 'CF-Access-Client-Id': accessId, 'CF-Access-Client-Secret': accessSecret } : {}),
    ...extra,
  };
}

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function json(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers: headers(init.headers as Record<string, string>) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

let cookie = '';
let csrf = '';

async function main(): Promise<void> {
  await check('healthz', async () => {
    const r = await json('/healthz');
    assert(r.status === 200, `status=${r.status}`);
    assert(r.body?.status === 'ok', `status=${r.body?.status}`);
    assert(r.body?.db?.ok === true, 'db not ok');
    return `v${r.body.version} commit=${r.body.commit} db=${r.body.db.latencyMs}ms`;
  });

  await check('readyz', async () => {
    const r = await json('/readyz');
    assert(r.status === 200, `status=${r.status}`);
    return 'ready';
  });

  await check('index.html', async () => {
    const res = await fetch(`${baseUrl}/`, { headers: headers() });
    assert(res.status === 200, `status=${res.status}`);
    const text = await res.text();
    assert(/<div id="root">|<title>/.test(text), 'HTMLではない');
    return `${text.length} bytes`;
  });

  if (email && password) {
    await check('login', async () => {
      const r = await json('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: baseUrl },
        body: JSON.stringify({ email, password }),
      });
      assert(r.status === 200, `status=${r.status} ${JSON.stringify(r.body?.error ?? '')}`);
      const setCookie = r.headers.get('set-cookie') ?? '';
      cookie = setCookie
        .split(',')
        .map((c) => c.split(';')[0])
        .join('; ');
      csrf = r.body.csrf;
      return `user=${r.body.user.displayName} roles=${r.body.user.roles.join(',')}`;
    });
  }

  const authed = cookie ? { cookie } : {};

  await check('meta', async () => {
    const r = await json('/api/meta', { headers: authed });
    assert(r.status === 200, `status=${r.status}`);
    return `env=${r.body.environment} v${r.body.version}`;
  });

  await check('home', async () => {
    const r = await json('/api/home', { headers: authed });
    assert(r.status === 200, `status=${r.status}`);
    return `yourTurn=${r.body.counts?.yourTurn} total=${r.body.counts?.total}`;
  });

  await check('catalog', async () => {
    const r = await json('/api/catalog/summary', { headers: authed });
    assert(r.status === 200, `status=${r.status}`);
    assert(r.body.tools === 118, `tools=${r.body.tools}`);
    assert(r.body.departments === 19, `departments=${r.body.departments}`);
    return `19部署/118件（青${r.body.g}/黄${r.body.y}/赤${r.body.r}）`;
  });

  await check('requests', async () => {
    const r = await json('/api/requests?pageSize=5', { headers: authed });
    assert(r.status === 200, `status=${r.status}`);
    assert(Array.isArray(r.body.items), 'items が配列でない');
    return `${r.body.total} 件`;
  });

  await check('export.json', async () => {
    const r = await json('/api/export.json', { headers: authed });
    assert(r.status === 200, `status=${r.status}`);
    assert(typeof r.body.seq === 'number', 'seq がない');
    return `${r.body.items.length} items`;
  });

  await check('export.csv', async () => {
    const res = await fetch(`${baseUrl}/api/export.csv`, { headers: headers(authed) });
    assert(res.status === 200, `status=${res.status}`);
    const text = await res.text();
    assert(text.charCodeAt(0) === 0xfeff, 'BOM がない');
    assert(text.includes('"受付番号"'), 'ヘッダがない');
    return `${text.length} bytes`;
  });

  await check('detail', async () => {
    const list = await json('/api/requests?pageSize=1', { headers: authed });
    const id = list.body.items?.[0]?.id;
    if (!id) return '依頼がないためスキップ';
    const r = await json(`/api/requests/${id}`, { headers: authed });
    assert(r.status === 200, `status=${r.status}`);
    return `${id} status=${r.body.request.status} suggested=${r.body.request.suggested?.color}`;
  });

  if (csrf && cookie) {
    await check('csrf（ダミー操作は拒否される）', async () => {
      const r = await json('/api/auth/role', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', origin: baseUrl, 'x-csrf-token': 'invalid' },
        body: JSON.stringify({ role: 'desk' }),
      });
      assert(r.status === 403, `想定403だが status=${r.status}`);
      return '不正CSRFは403';
    });
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'NG  '} ${r.name}: ${r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} OK`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
