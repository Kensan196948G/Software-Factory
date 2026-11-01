/**
 * 実 Docker で検証環境の配備の部品を確かめる（`pnpm test:docker`）。外部へは送らない。
 * ローカルで作るダミーのイメージだけを使う（FROM は手元の node:22-bookworm-slim。pull しない）。
 * 触るのはこの試験が作った、ラベル msf.devline.deploy=1 のものだけ。
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeployDocker, createDeployProbe } from '../../src/worker/deploy-docker.js';

const suffix = randomBytes(4).toString('hex');
const name = `msf-deploy-test-${suffix}`;
const foreignName = `msf-deploy-foreign-${suffix}`;
const tagGood = `msf-deploy-test-good:${suffix}`;
const tagBad = `msf-deploy-test-bad:${suffix}`;
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const SERVER = String.raw`const { createServer } = require('node:http');
const fs = require('node:fs');
const version = process.env.APP_VERSION;
let writable = false;
try { fs.writeFileSync('/app/x', 'x'); writable = true; } catch {}
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/healthz') return res.end(JSON.stringify({ status: 'ok', version, writable, uid: process.getuid() }));
  if (url.pathname === '/length') return res.end(JSON.stringify({ length: (url.searchParams.get('text') ?? '').length + LENGTH_DELTA }));
  res.statusCode = 404; res.end('{}');
}).listen(8080, '0.0.0.0');`;

const docker = createDeployDocker();
const probe = createDeployProbe({ attempts: 20, intervalMs: 300 });
let dir = '';
let digestGood = '';
let digestBad = '';
let port = 0;

function raw(...args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return `${r.stdout ?? ''}`.trim();
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const p = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(p));
    });
  });
}

function context(delta: number): string {
  const d = mkdtempSync(join(dir, 'ctx-'));
  writeFileSync(join(d, 'server.js'), SERVER.replace('LENGTH_DELTA', String(delta)));
  writeFileSync(
    join(d, 'Dockerfile'),
    'FROM node:22-bookworm-slim\nWORKDIR /app\nCOPY server.js ./\nUSER node\nCMD ["node","server.js"]\n',
  );
  return d;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'msf-deploy-docker-'));
  port = await freePort();
  digestGood = await docker.build({ contextDir: context(0), tag: tagGood, sha: SHA });
  digestBad = await docker.build({ contextDir: context(1), tag: tagBad, sha: OTHER });
});

afterAll(async () => {
  await docker.remove(name).catch(() => undefined);
  spawnSync('docker', ['rm', '-f', foreignName]);
  for (const image of [tagGood, tagBad]) spawnSync('docker', ['rmi', '-f', image]);
  rmSync(dir, { recursive: true, force: true });
});

describe('検証環境の配備の部品（実 Docker）', () => {
  it('digest を記録できる形で返し、ラベルが付く', async () => {
    expect(digestGood).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await docker.hasImage(digestGood)).toBe(true);
    expect(raw('image', 'inspect', '--format', '{{index .Config.Labels "msf.devline.sha"}}', digestGood)).toBe(SHA);
  });

  it('ラベルの無いイメージは自分のものとして扱わない', async () => {
    expect(await docker.hasImage(`sha256:${'0'.repeat(64)}`)).toBe(false);
  });

  it('127.0.0.1 の固定ポート・read-only・cap-drop ALL・no-new-privileges で起動し、health と smoke が通る', async () => {
    await docker.run({ name, digest: digestGood, port, version: SHA });
    const inspect = JSON.parse(raw('inspect', name))[0];
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.HostConfig.CapDrop).toContain('ALL');
    expect(inspect.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(inspect.HostConfig.PortBindings['8080/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: String(port) }]);
    expect(inspect.Config.Labels['msf.devline.deploy']).toBe('1');
    expect(inspect.Image).toBe(digestGood);
    expect(await docker.containerState(name)).toBe('own');
    expect(await probe.check(port, SHA)).toEqual({ health: true, smoke: true });
    expect(await docker.portFree(port)).toBe(false);
  });

  it('使用中のポートでの起動は失敗する', async () => {
    const second = `${name}-2`;
    await expect(docker.run({ name: second, digest: digestGood, port, version: SHA })).rejects.toThrow();
    await docker.remove(second).catch(() => undefined);
  });

  it('version が SHA と違えば health は落ちる', async () => {
    const quick = createDeployProbe({ attempts: 2, intervalMs: 100 });
    expect(await quick.check(port, OTHER)).toEqual({ health: false, smoke: false });
  });

  it('消すと同じ digest をそのまま起動し直せる。smoke に落ちる版を見分ける', async () => {
    await docker.remove(name);
    expect(await docker.containerState(name)).toBe('none');
    await docker.run({ name, digest: digestBad, port, version: OTHER });
    expect(await probe.check(port, OTHER)).toEqual({ health: true, smoke: false });
    await docker.remove(name);
    await docker.run({ name, digest: digestGood, port, version: SHA });
    expect(await probe.check(port, SHA)).toEqual({ health: true, smoke: true });
    await docker.remove(name);
  });

  it('同じ名前の、配備のラベルの無いコンテナは消さない', async () => {
    // 配備のラベル（msf.devline.deploy）は無いが、この試験のものと分かるラベル（msf.devline）は付ける
    spawnSync('docker', ['create', '--name', foreignName, '--label', 'msf.devline=1', 'node:22-bookworm-slim', 'true']);
    expect(await docker.containerState(foreignName)).toBe('foreign');
    await expect(docker.remove(foreignName)).rejects.toThrow();
    expect(raw('ps', '-a', '--filter', `name=^/${foreignName}$`, '--format', '{{.Names}}')).toBe(foreignName);
  });
});
