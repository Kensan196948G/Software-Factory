/** merge・配備・戻しの判定（純関数）と、merge の口の分類。実 GitHub へは送らない。 */
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGithubPrMergeAdapter } from '../../src/api/pr-adapter.js';
import {
  decideDeploy,
  decideMerge,
  decideRollback,
  healthMatches,
  smokeMatches,
  type DeployFacts,
  type MergeFacts,
  type RollbackFacts,
} from '../../src/shared/devline-release.js';
import { workerTick } from '../../src/worker/main.js';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const DIGEST = `sha256:${'d'.repeat(64)}`;

const merge = (over: Partial<MergeFacts> = {}): MergeFacts => ({
  approver: { role: 'approver', isAgent: false },
  jobState: 'pr_ready',
  jobHeadSha: HEAD,
  requestedHeadSha: HEAD,
  superseded: false,
  orderCurrent: true,
  verdict: 'passed',
  acAllConfirmed: true,
  hasPr: true,
  mergeState: 'none',
  mergeDetail: null,
  sendingFresh: false,
  approvedHeadSha: null,
  ...over,
});

const deploy = (over: Partial<DeployFacts> = {}): DeployFacts => ({
  approver: { role: 'approver', isAgent: false },
  jobState: 'merged',
  superseded: false,
  orderCurrent: true,
  mergeSha: HEAD,
  treeMatch: true,
  imageDigest: DIGEST,
  artifactHealth: true,
  artifactSmoke: true,
  environment: 'local-verify',
  requested: { sha: HEAD, digest: DIGEST, environment: 'local-verify' },
  ...over,
});

const rollback = (over: Partial<RollbackFacts> = {}): RollbackFacts => ({
  approver: { role: 'approver', isAgent: false },
  jobState: 'staged',
  imageDigest: DIGEST,
  previousDigest: `sha256:${'e'.repeat(64)}`,
  environmentDigest: DIGEST,
  ...over,
});

describe('失効の規則', () => {
  it('merge: 正常', () => {
    expect(decideMerge(merge())).toEqual({ ok: true, mode: 'send' });
    // 照合は条件を問わず読むだけ（送るかどうかの分岐を持たない）
    for (const over of [{}, { orderCurrent: false }, { superseded: true }, { verdict: 'failed' as const }]) {
      expect(decideMerge(merge({ mergeState: 'unknown', ...over }))).toEqual({ ok: true, mode: 'reconcile' });
    }
    expect(decideMerge(merge({ jobState: 'merged' }))).toEqual({ ok: true, mode: 'already_merged' });
  });

  it.each<[string, Partial<MergeFacts>, string]>([
    ['head が変わる', { requestedHeadSha: OTHER }, 'head_changed'],
    ['版が上がる（superseded）', { superseded: true }, 'superseded'],
    ['注文書が無効', { orderCurrent: false }, 'order_not_current'],
    ['役割が違う', { approver: { role: 'desk', isAgent: false } }, 'role'],
    ['AI の利用者', { approver: { role: 'approver', isAgent: true } }, 'agent_actor'],
    ['検査の失敗', { verdict: 'failed' }, 'verification'],
    ['検査が揃わない（skip・欠落）', { verdict: 'incomplete' as MergeFacts['verdict'] }, 'verification'],
    ['AC の未確認', { acAllConfirmed: false }, 'verification'],
    ['PR がない', { hasPr: false }, 'no_pr'],
    ['別の押下が送信中', { mergeState: 'sending', sendingFresh: true }, 'in_progress'],
    ['前回失効', { mergeState: 'rejected', mergeDetail: 'head_changed' }, 'expired'],
    ['状態が違う', { jobState: 'verifying' }, 'state'],
  ])('merge を拒否: %s', (_name, over, refusal) => {
    expect(decideMerge(merge(over))).toMatchObject({ ok: false, refusal });
  });

  it('配備: 正常', () => {
    expect(decideDeploy(deploy())).toEqual({ ok: true });
  });

  it.each<[string, Partial<DeployFacts>, string]>([
    [
      'digest が違う',
      { requested: { sha: HEAD, digest: `sha256:${'f'.repeat(64)}`, environment: 'local-verify' } },
      'digest_mismatch',
    ],
    ['SHA が違う', { requested: { sha: OTHER, digest: DIGEST, environment: 'local-verify' } }, 'sha_mismatch'],
    ['環境が違う', { requested: { sha: HEAD, digest: DIGEST, environment: 'prod' } }, 'environment_mismatch'],
    ['版が上がる', { superseded: true }, 'superseded'],
    ['注文書が無効', { orderCurrent: false }, 'order_not_current'],
    ['役割が違う', { approver: { role: 'requester', isAgent: false } }, 'role'],
    ['AI の利用者', { approver: { role: 'approver', isAgent: true } }, 'agent_actor'],
    ['merge 前', { jobState: 'pr_ready' }, 'state'],
    ['配備済み', { jobState: 'staged' }, 'state'],
    ['tree が違う', { treeMatch: false }, 'tree_mismatch'],
    ['tree が未確認', { treeMatch: null }, 'tree_mismatch'],
    ['成果物が未検査', { artifactSmoke: false }, 'no_artifact'],
    ['成果物がない', { imageDigest: null }, 'no_artifact'],
  ])('配備を拒否: %s', (_name, over, refusal) => {
    expect(decideDeploy(deploy(over))).toMatchObject({ ok: false, refusal });
  });

  it.each<[string, Partial<RollbackFacts>, string]>([
    ['役割が違う', { approver: { role: 'desk', isAgent: false } }, 'role'],
    ['AI の利用者', { approver: { role: 'approver', isAgent: true } }, 'agent_actor'],
    ['配備前', { jobState: 'merged' }, 'state'],
    ['別の版が載っている', { environmentDigest: `sha256:${'f'.repeat(64)}` }, 'not_current'],
    ['戻す先がない', { previousDigest: null }, 'nothing_to_restore'],
  ])('戻しを拒否: %s', (_name, over, refusal) => {
    expect(decideRollback(rollback(over))).toMatchObject({ ok: false, refusal });
  });

  it('health と smoke の判定', () => {
    expect(healthMatches({ status: 'ok', version: HEAD }, HEAD)).toBe(true);
    expect(healthMatches({ status: 'ok', version: OTHER }, HEAD)).toBe(false);
    expect(healthMatches(null, HEAD)).toBe(false);
    expect(smokeMatches('{"length":3}')).toBe(true);
    expect(smokeMatches('3')).toBe(true);
    expect(smokeMatches('{"length":4}')).toBe(false);
    expect(smokeMatches('<html>')).toBe(false);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

describe('worker の1回分（配備を飢えさせない）', () => {
  const quiet = { log: (): void => undefined, logError: (): void => undefined };

  it('runOnce が例外でも配備は動く', async () => {
    const deploy = vi.fn(async () => ({ kind: 'done', attemptKind: 'deploy', state: 'succeeded', errorCode: null }) as const);
    const idle = await workerTick({
      runOnce: async () => {
        throw new Error('db');
      },
      deploy,
      ...quiet,
    });
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(idle).toBe(false);
  });

  it('配備の例外は外へ出さず、両方が例外なら待つ側へ倒す。止める合図の後は配備を呼ばない', async () => {
    const fail = async (): Promise<never> => {
      throw new Error('x');
    };
    expect(await workerTick({ runOnce: fail, deploy: fail, ...quiet })).toBe(true);
    const stop = new AbortController();
    stop.abort();
    const deploy = vi.fn(async () => ({ kind: 'idle' }) as const);
    await workerTick({ runOnce: fail, deploy, shutdown: stop.signal, ...quiet });
    expect(deploy).not.toHaveBeenCalled();
  });
});

describe('merge の資格情報', () => {
  it('API は投入と同じ関数で GitHub のトークンだけを読む。worker を import しない', () => {
    const text = readFileSync(join('src', 'api', 'devline-release.ts'), 'utf8');
    expect(text).toContain('loadDevlineGithubToken(config.devlineSecretsFile || DEFAULT_SECRETS_PATH, config.nodeEnv)');
    expect(text).not.toMatch(/worker\//);
    expect(text).not.toMatch(/\bimport\(/);
    expect(text).not.toContain('loadDevlineSecrets');
    expect(text).not.toContain('ANTHROPIC');
    expect(text).not.toContain('process.env');
  });
});

describe('merge の口は人の承認の経路だけ', () => {
  it('src のうち merge の口を作るのは devline-release.ts だけ。worker は承認の経路を import しない', () => {
    const users = walk('src').filter(
      (f) => !f.endsWith('pr-adapter.ts') && readFileSync(f, 'utf8').includes('createGithubPrMergeAdapter'),
    );
    expect(users).toEqual([join('src', 'api', 'devline-release.ts')]);
    for (const file of walk(join('src', 'worker'))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/api\/devline-release\.js'/);
      expect(text, file).not.toMatch(/\bmergePull\b|\/merge\b/);
    }
  });

  it('merge の API を呼ぶのは pr-adapter.ts だけ', () => {
    const hits = walk('src').filter((f) => /pulls\/\$\{[^}]+\}\/merge/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([join('src', 'api', 'pr-adapter.ts')]);
  });

  it('画面と API に本番公開の経路を作らない', () => {
    const app = readFileSync(join('src', 'api', 'app.ts'), 'utf8');
    expect(app).not.toMatch(/\/api\/jobs\/:id\/(release|publish|approve-release)/);
    const code = readFileSync(join('src', 'api', 'devline-release.ts'), 'utf8');
    expect(code).not.toMatch(/state='(released|closed)'/);
    const worker = readFileSync(join('src', 'worker', 'deploy-worker.ts'), 'utf8');
    expect(worker).not.toMatch(/state='(released|closed)'/);
  });
});

describe('merge の口の分類（ローカルのサーバ）', () => {
  let server: Server;
  let url = '';
  const seen: { method: string; url: string; body: any }[] = [];
  let reply: { status: number; body?: unknown; destroy?: boolean } = { status: 200 };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => {
        raw += c.toString('utf8');
      });
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : null });
        if (reply.destroy) return void res.destroy();
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body ?? {}));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const adapter = () => createGithubPrMergeAdapter({ token: 'dummy-not-a-secret', apiUrl: url, nodeEnv: 'test' });
  const send = () => adapter().mergePull({ repo: 'o/r', number: 7, sha: HEAD, title: 't' }, AbortSignal.timeout(2000));

  it('squash と sha を PUT で送る。成功を読む', async () => {
    seen.length = 0;
    reply = { status: 200, body: { merged: true, sha: OTHER } };
    expect(await send()).toEqual({ outcome: 'merged', mergeSha: OTHER });
    expect(seen[0]).toMatchObject({
      method: 'PUT',
      url: '/repos/o/r/pulls/7/merge',
      body: { merge_method: 'squash', sha: HEAD },
    });
  });

  it.each([
    [{ status: 409 }, { outcome: 'rejected', cause: 'head_changed' }],
    [{ status: 405 }, { outcome: 'rejected', cause: 'not_mergeable' }],
    [{ status: 403 }, { outcome: 'rejected', cause: 'refused' }],
    [{ status: 429 }, { outcome: 'rejected', cause: 'rate_limited' }],
    [{ status: 502 }, { outcome: 'unknown', reason: 'http' }],
    [
      { status: 200, body: { merged: false } },
      { outcome: 'unknown', reason: 'bad_response' },
    ],
    [
      { status: 0, destroy: true },
      { outcome: 'unknown', reason: 'network' },
    ],
  ])('応答 %j を分類する', async (r, expected) => {
    reply = r;
    expect(await send()).toMatchObject(expected);
  });

  it('PR と commit を読む', async () => {
    reply = {
      status: 200,
      body: {
        number: 7,
        html_url: 'http://x/7',
        state: 'closed',
        merged: true,
        merge_commit_sha: OTHER,
        user: { login: 'bot' },
        head: { sha: HEAD, ref: 'b', repo: { full_name: 'o/r' } },
        base: { ref: 'main' },
      },
    };
    const pull = await adapter().getPull({ repo: 'o/r', number: 7 }, AbortSignal.timeout(2000));
    expect(pull).toMatchObject({ ok: true, value: { merged: true, mergeSha: OTHER, baseRef: 'main', headSha: HEAD } });
    reply = { status: 200, body: { tree: { sha: OTHER } } };
    expect(await adapter().getCommitTree({ repo: 'o/r', sha: HEAD }, AbortSignal.timeout(2000))).toEqual({
      ok: true,
      value: OTHER,
    });
    reply = { status: 404 };
    expect(await adapter().getPull({ repo: 'o/r', number: 7 }, AbortSignal.timeout(2000))).toEqual({ ok: true, value: null });
  });
});
