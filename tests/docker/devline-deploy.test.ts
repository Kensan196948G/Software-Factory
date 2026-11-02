/**
 * 実 Docker で検証環境の配備の部品を確かめる（`pnpm test:docker`）。外部へは送らない。
 * ローカルで作るダミーのイメージだけを使う（FROM は手元の node:22-bookworm-slim。pull しない）。
 * CI の artifact の代わりに docker save した tar を読み込む。実 GitHub の artifact の確認ではない。
 * 触るのはこの試験が作った、ラベル msf.devline.deploy=1 か msf.devline=1 のものと、msf-sandbox-verify:test-* のタグだけ。
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEPLOY_ARTIFACT_TAG } from '../../src/shared/devline-release.js';
import { tarHasOnlyExpectedTag } from '../../src/worker/deploy-artifact.js';
import { createDeployDocker, createDeployProbe, DEPLOY_IMAGE_REPO } from '../../src/worker/deploy-docker.js';

const suffix = randomBytes(4).toString('hex');
const name = `msf-deploy-test-${suffix}`;
const foreignName = `msf-deploy-foreign-${suffix}`;
const network = `msf-deploy-test-net-${suffix}`;
const tagGood = `${DEPLOY_IMAGE_REPO}:test-good-${suffix}`;
const tagBad = `${DEPLOY_IMAGE_REPO}:test-bad-${suffix}`;
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

const docker = createDeployDocker({ network });
const probe = createDeployProbe({ attempts: 20, intervalMs: 300 });
let dir = '';
let digestGood = '';
let digestBad = '';
let baseUrl = '';

function raw(...args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return `${r.stdout ?? ''}`.trim();
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

/** CI と同じ形で作る：build → save → ローカルから消す → loadImage（配備の部品が使う口）→ 自分のタグ。 */
async function artifactOf(delta: number, tag: string): Promise<{ tar: string; id: string }> {
  // 他のプロジェクトのものと分かれるよう、ラベルを付ける。CI の image に付くラベルではない
  spawnSync('docker', ['build', '-q', '--label', 'msf.devline=1', '-t', DEPLOY_ARTIFACT_TAG, context(delta)], {
    encoding: 'utf8',
  });
  const expected = raw('image', 'inspect', '--format', '{{.Id}}', DEPLOY_ARTIFACT_TAG);
  const tar = join(dir, `${tag.replace(/\W/g, '-')}.tar`);
  spawnSync('docker', ['save', '-o', tar, DEPLOY_ARTIFACT_TAG]);
  spawnSync('docker', ['image', 'rm', DEPLOY_ARTIFACT_TAG]);
  const loaded = await docker.loadImage(tar);
  expect(loaded).toEqual({ ref: DEPLOY_ARTIFACT_TAG, id: expected });
  await docker.adoptImage({ ...loaded, tag });
  return { tar, id: loaded.id };
}

let goodTar = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'msf-deploy-docker-'));
  const good = await artifactOf(0, tagGood);
  goodTar = good.tar;
  digestGood = good.id;
  digestBad = (await artifactOf(1, tagBad)).id;
});

afterAll(async () => {
  await docker.remove(name).catch(() => undefined);
  spawnSync('docker', ['rm', '-f', foreignName]);
  for (const image of [tagGood, tagBad, DEPLOY_ARTIFACT_TAG]) spawnSync('docker', ['rmi', image]);
  spawnSync('docker', ['network', 'rm', network]);
  rmSync(dir, { recursive: true, force: true });
});

describe('検証環境の配備の部品（実 Docker）', () => {
  it('save → load で ID が変わらず、読み込み時のタグが外れて自分のタグだけ残る', () => {
    expect(digestGood).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(tarHasOnlyExpectedTag(goodTar)).toBe(true);
    expect(raw('image', 'inspect', '--format', '{{json .RepoTags}}', digestGood)).toBe(JSON.stringify([tagGood]));
  });

  it('自分のタグの無いイメージは自分のものとして扱わない', async () => {
    expect(await docker.hasImage(digestGood)).toBe(true);
    expect(await docker.hasImage(`sha256:${'0'.repeat(64)}`)).toBe(false);
    expect(await docker.hasImage('node:22-bookworm-slim')).toBe(false);
  });

  it('内部ネットワーク・ポート公開なし・host mount なし・read-only・cap-drop ALL で起動し、host から health と smoke が通る。外へ出られない', async () => {
    ({ baseUrl } = await docker.run({ name, digest: digestGood, version: SHA }));
    const inspect = JSON.parse(raw('inspect', name))[0];
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.HostConfig.CapDrop).toContain('ALL');
    expect(inspect.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(inspect.HostConfig.Privileged).toBe(false);
    expect(inspect.HostConfig.NetworkMode).toBe(network);
    expect(inspect.HostConfig.Binds ?? []).toEqual([]);
    expect(inspect.HostConfig.PortBindings ?? {}).toEqual({});
    expect(inspect.Mounts.filter((m: { Type: string }) => m.Type === 'bind')).toEqual([]);
    expect(raw('network', 'inspect', '--format', '{{.Internal}}', network)).toBe('true');
    expect(inspect.Config.Labels['msf.devline.deploy']).toBe('1');
    expect(inspect.Image).toBe(digestGood);
    expect(await docker.containerState(name)).toBe('own');
    expect(await probe.check(baseUrl, SHA)).toEqual({ health: true, smoke: true });
    const out = spawnSync(
      'docker',
      [
        'exec',
        name,
        'node',
        '-e',
        "require('net').connect({host:'1.1.1.1',port:443,timeout:2000}).on('connect',()=>{console.log('reached');process.exit()}).on('error',()=>{console.log('blocked');process.exit()}).on('timeout',()=>{console.log('blocked');process.exit()})",
      ],
      { encoding: 'utf8' },
    );
    expect(out.stdout.trim()).toBe('blocked');
  });

  it('同じ名前でラベルの無いネットワークには入らない', async () => {
    const foreignNet = `msf-deploy-foreign-net-${suffix}`;
    spawnSync('docker', ['network', 'create', '--internal', '--label', 'msf.devline=1', foreignNet]);
    const other = createDeployDocker({ network: foreignNet });
    await expect(other.run({ name: `${name}-f`, digest: digestGood, version: SHA })).rejects.toThrow();
    spawnSync('docker', ['network', 'rm', foreignNet]);
  });

  it('version が SHA と違えば health は落ちる', async () => {
    const quick = createDeployProbe({ attempts: 2, intervalMs: 100 });
    expect(await quick.check(baseUrl, OTHER)).toEqual({ health: false, smoke: false });
  });

  it('消すと同じ digest をそのまま起動し直せる。smoke に落ちる版を見分ける', async () => {
    await docker.remove(name);
    expect(await docker.containerState(name)).toBe('none');
    ({ baseUrl } = await docker.run({ name, digest: digestBad, version: OTHER }));
    expect(await probe.check(baseUrl, OTHER)).toEqual({ health: true, smoke: false });
    await docker.remove(name);
    ({ baseUrl } = await docker.run({ name, digest: digestGood, version: SHA }));
    expect(await probe.check(baseUrl, SHA)).toEqual({ health: true, smoke: true });
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
