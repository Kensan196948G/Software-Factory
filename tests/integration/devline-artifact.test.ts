/**
 * CI の成果物（artifact `image`）の取得と照合。GitHub はローカルの作り物の HTTP サーバ。実 GitHub へは送らない。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createImageArtifactSource,
  extractImageArtifact,
  imageMetaMatches,
  parseImageMeta,
  selectImageArtifact,
  tarHasOnlyExpectedTag,
  type ImageArtifactRequest,
} from '../../src/worker/deploy-artifact.js';
import { deployRunArgs, parseLoadOutput } from '../../src/worker/deploy-docker.js';
import { buildZip } from './devline-real-harness.js';

const REPO = 'owner/sandbox';
const RUN = '4242';
const HEAD = 'a'.repeat(40);
const IMAGE = `sha256:${'b'.repeat(64)}`;
const TOKEN = 'dummy-not-a-secret';

interface TarEntry {
  name: string;
  data?: string | Buffer;
  type?: string;
  prefix?: string;
  magic?: string;
  /** ヘッダの size を中身と違う値にする。 */
  size?: number;
}

/** 1 項目分のブロック。checksum は実物の tar と同じ規則で付ける。 */
function tarEntry(e: TarEntry): Buffer {
  const data = Buffer.from(e.data ?? '');
  const size = e.size ?? data.length;
  const header = Buffer.alloc(512);
  header.write(e.name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write(e.type ?? '0', 156, 1, 'latin1');
  header.write(e.magic ?? 'ustar\x0000', 257, 'latin1');
  if (e.prefix) header.write(e.prefix, 345, 155, 'utf8');
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

const tarRaw = (entries: TarEntry[]): Buffer => Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]);

/** docker save の形に近い最小の tar（manifest.json だけが読まれる）。 */
function tarOf(files: Record<string, string | Buffer>): Buffer {
  return tarRaw(Object.entries(files).map(([name, data]) => ({ name, data })));
}

const goodTar = (tag = 'sandbox-artifact:ci', extra: Record<string, string> = {}): Buffer =>
  tarOf({
    [`blobs/sha256/${'c'.repeat(64)}`]: randomBytes(1300),
    ...extra,
    'manifest.json': JSON.stringify([{ Config: `blobs/sha256/${IMAGE.slice(7)}`, RepoTags: [tag], Layers: [] }]),
  });

const metaOf = (tar: Buffer, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 'msf.image/v1',
    repository: REPO,
    runId: RUN,
    runAttempt: '2',
    headSha: HEAD,
    imageId: IMAGE,
    tarSha256: createHash('sha256').update(tar).digest('hex'),
    ...over,
  });

const req: ImageArtifactRequest = { repo: REPO, runId: RUN, runAttempt: 2, headSha: HEAD };

interface Fixture {
  artifacts: unknown[];
  zip: Buffer;
  zipStatus: number;
  hits: { url: string; auth: string | undefined }[];
  attemptStartedAt: string | null;
}
const fx: Fixture = { artifacts: [], zip: Buffer.alloc(0), zipStatus: 200, hits: [], attemptStartedAt: null };
let server: Server;
let base = '';
let dir = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'msf-artifact-test-'));
  server = createServer((q, s) => {
    const url = q.url ?? '';
    fx.hits.push({ url, auth: q.headers.authorization });
    if (url.startsWith(`/repos/${REPO}/actions/runs/${RUN}/artifacts`)) {
      s.setHeader('content-type', 'application/json');
      return s.end(JSON.stringify({ artifacts: fx.artifacts }));
    }
    if (url === `/repos/${REPO}/actions/runs/${RUN}/attempts/2` && fx.attemptStartedAt) {
      s.setHeader('content-type', 'application/json');
      return s.end(JSON.stringify({ run_started_at: fx.attemptStartedAt }));
    }
    if (url === `/repos/${REPO}/actions/artifacts/77/zip`) {
      s.writeHead(302, { location: `${base}/blob/77` });
      return s.end();
    }
    if (url === '/blob/77') {
      s.writeHead(fx.zipStatus);
      return s.end(fx.zipStatus === 200 ? fx.zip : undefined);
    }
    s.writeHead(404);
    s.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const artifact = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 77,
  name: 'image',
  size_in_bytes: 100,
  expired: false,
  workflow_run: { id: Number(RUN), head_sha: HEAD },
  ...over,
});

const source = (over: Record<string, unknown> = {}) =>
  createImageArtifactSource({ apiUrl: base, token: TOKEN, nodeEnv: 'test', workDir: dir, ...over });

beforeEach(() => {
  fx.hits = [];
  fx.zipStatus = 200;
  fx.artifacts = [artifact()];
  fx.attemptStartedAt = null;
});

describe('取得と照合', () => {
  it('正しい成果物を保存して照合する。追う先へ token を送らない。cleanup で消える', async () => {
    const tar = goodTar();
    fx.zip = buildZip({ 'image.tar': tar, 'image-meta.json': metaOf(tar) });
    const got = await source().fetch(req);
    expect(got).toMatchObject({ ok: true, imageId: IMAGE, artifactId: 77, runId: RUN, runAttempt: 2 });
    if (!got.ok) throw new Error('unreachable');
    expect(readFileSync(got.tarPath).equals(tar)).toBe(true);
    expect(got.tarSha256).toBe(createHash('sha256').update(tar).digest('hex'));
    expect(fx.hits.find((h) => h.url === '/blob/77')?.auth).toBeUndefined();
    expect(fx.hits.find((h) => h.url.includes('/artifacts/77/zip'))?.auth).toBe(`Bearer ${TOKEN}`);
    got.cleanup();
    expect(existsSync(got.tarPath)).toBe(false);
  });

  it('無い run の成果物（PR #5 より古い run）は missing。fake の run ID は問い合わせない', async () => {
    fx.artifacts = [];
    expect(await source().fetch(req)).toEqual({ ok: false, problem: 'missing' });
    fx.hits = [];
    expect(await source().fetch({ ...req, runId: 'fake-run-1' })).toEqual({ ok: false, problem: 'missing' });
    expect(fx.hits).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['repository', { repository: 'owner/other' }],
    ['run', { runId: '1' }],
    ['attempt', { runAttempt: '1' }],
    ['head', { headSha: 'c'.repeat(40) }],
    ['tar のハッシュ', { tarSha256: 'd'.repeat(64) }],
    ['schema', { schema: 'msf.image/v2' }],
    ['imageId の形', { imageId: 'latest' }],
  ])('meta の %s が違えば mismatch で作業場を残さない', async (_n, over) => {
    const tar = goodTar();
    fx.zip = buildZip({ 'image.tar': tar, 'image-meta.json': metaOf(tar, over) });
    expect(await source().fetch(req)).toEqual({ ok: false, problem: 'mismatch' });
  });

  it('artifact の workflow_run が根拠の run・head と違えば取得しない', async () => {
    fx.artifacts = [artifact({ workflow_run: { id: 1, head_sha: HEAD } })];
    expect(await source().fetch(req)).toEqual({ ok: false, problem: 'mismatch' });
    fx.artifacts = [artifact({ workflow_run: { id: Number(RUN), head_sha: 'c'.repeat(40) } })];
    expect(await source().fetch(req)).toEqual({ ok: false, problem: 'mismatch' });
    fx.artifacts = [artifact(), artifact({ id: 78 })];
    expect(await source().fetch(req)).toEqual({ ok: false, problem: 'mismatch' });
    expect(fx.hits.some((h) => h.url.includes('/zip'))).toBe(false);
  });

  it('再実行で前の試行の artifact が残っていても、試行の開始より後のものだけを使う', async () => {
    const tar = goodTar();
    fx.zip = buildZip({ 'image.tar': tar, 'image-meta.json': metaOf(tar) });
    fx.artifacts = [
      artifact({ id: 76, created_at: '2026-11-01T00:00:00Z' }),
      artifact({ id: 77, created_at: '2026-11-01T02:00:00Z' }),
    ];
    fx.attemptStartedAt = '2026-11-01T01:00:00Z';
    const got = await source().fetch(req);
    expect(got).toMatchObject({ ok: true, artifactId: 77 });
    if (got.ok) got.cleanup();
    // 失敗した job だけの再実行で、この試行の artifact が無い
    fx.artifacts = [
      artifact({ id: 76, created_at: '2026-11-01T00:00:00Z' }),
      artifact({ id: 75, created_at: '2026-11-01T00:00:00Z' }),
    ];
    expect(await source().fetch(req)).toEqual({ ok: false, problem: 'missing' });
  });

  it('期限切れ・大きさの上限・取得の失敗を分ける', async () => {
    fx.artifacts = [artifact({ expired: true })];
    expect(await source().fetch(req)).toEqual({ ok: false, problem: 'expired' });

    fx.artifacts = [artifact({ size_in_bytes: 10_000 })];
    const small = source({ limits: { maxZipBytes: 1000, maxTarBytes: 1000 } });
    expect(await small.fetch(req)).toEqual({ ok: false, problem: 'too_large' });

    // 申告が小さくても、実際の大きさで止める
    fx.artifacts = [artifact({ size_in_bytes: 1 })];
    const tar = goodTar();
    fx.zip = buildZip({ 'image.tar': tar, 'image-meta.json': metaOf(tar) }, 0);
    expect(await small.fetch(req)).toEqual({ ok: false, problem: 'too_large' });

    fx.artifacts = [artifact()];
    fx.zipStatus = 410;
    expect(await source().fetch(req)).toEqual({ ok: false, problem: 'expired' });
    fx.zipStatus = 500;
    expect(await source().fetch(req)).toEqual({ ok: false, problem: 'unavailable' });
  });

  it('tar のタグが想定と違えば（他のタグの上書きを防ぐ）読み込ませない', async () => {
    const tar = goodTar('other-project:latest');
    fx.zip = buildZip({ 'image.tar': tar, 'image-meta.json': metaOf(tar) });
    expect(await source().fetch(req)).toEqual({ ok: false, problem: 'mismatch' });
  });

  it('作業場を残さない（失敗のとき）', async () => {
    const before = fx.hits.length;
    expect(before).toBe(0);
    const clean = mkdtempSync(join(dir, 'clean-'));
    const tar = goodTar();
    fx.zip = buildZip({ 'image.tar': tar, 'image-meta.json': metaOf(tar, { runId: '1' }) });
    await source({ workDir: clean }).fetch(req);
    expect(readdirSync(clean)).toEqual([]);
  });
});

describe('zip の展開', () => {
  const write = (name: string, data: Buffer): string => {
    const p = join(dir, `${randomBytes(4).toString('hex')}-${name}`);
    writeFileSync(p, data);
    return p;
  };
  const out = (): string => mkdtempSync(join(dir, 'out-'));

  it('余分なファイル・欠けたファイル・壊れた zip を拒否する', async () => {
    const tar = goodTar();
    const meta = metaOf(tar);
    for (const zip of [
      buildZip({ 'image.tar': tar }),
      buildZip({ 'image.tar': tar, 'image-meta.json': meta, 'x.txt': 'x' }),
      buildZip({ '../image.tar': tar, 'image-meta.json': meta }),
      Buffer.from('not a zip at all, not even close, really'),
    ]) {
      expect(await extractImageArtifact(write('a.zip', zip), out())).toEqual({ ok: false, problem: 'mismatch' });
    }
  });

  it('CRC が合わなければ拒否する', async () => {
    const tar = goodTar();
    const zip = buildZip({ 'image.tar': tar, 'image-meta.json': metaOf(tar) }, 0);
    // tar の中身を1バイト壊す（ローカルヘッダの後）
    zip[100] = zip[100]! ^ 0xff;
    expect(await extractImageArtifact(write('b.zip', zip), out())).toEqual({ ok: false, problem: 'mismatch' });
  });

  it('展開後の上限を超えたら止める（zip 爆弾）', async () => {
    const tar = tarOf({ 'manifest.json': '[]', big: Buffer.alloc(2_000_000) });
    const zip = buildZip({ 'image.tar': tar, 'image-meta.json': metaOf(tar) });
    expect(zip.length).toBeLessThan(100_000);
    expect(await extractImageArtifact(write('c.zip', zip), out(), { maxZipBytes: 100_000, maxTarBytes: 100_000 })).toEqual({
      ok: false,
      problem: 'too_large',
    });
  });
});

describe('純関数', () => {
  it('selectImageArtifact は名前の違うものを無視する', () => {
    expect(selectImageArtifact([artifact({ name: 'ac-results' }) as never], { runId: RUN, headSha: HEAD })).toEqual({
      ok: false,
      problem: 'missing',
    });
  });

  it('parseImageMeta は数値の run を受けない（CI は文字列で書く）', () => {
    const tar = goodTar();
    expect(parseImageMeta(Buffer.from(metaOf(tar)))).toMatchObject({ runId: RUN, runAttempt: '2' });
    expect(parseImageMeta(Buffer.from(metaOf(tar, { runId: 4242 })))).toBeNull();
    expect(parseImageMeta(Buffer.from('{'))).toBeNull();
  });

  it('imageMetaMatches は attempt を文字列で比べる', () => {
    const meta = parseImageMeta(Buffer.from(metaOf(goodTar())))!;
    expect(imageMetaMatches(meta, req)).toBe(true);
    expect(imageMetaMatches(meta, { ...req, runAttempt: 1 })).toBe(false);
  });

  it('tarHasOnlyExpectedTag', () => {
    const p = (b: Buffer): string => {
      const f = join(dir, `${randomBytes(4).toString('hex')}.tar`);
      writeFileSync(f, b);
      return f;
    };
    expect(tarHasOnlyExpectedTag(p(goodTar()))).toBe(true);
    expect(tarHasOnlyExpectedTag(p(goodTar('x:y')))).toBe(false);
    expect(tarHasOnlyExpectedTag(p(tarOf({ other: 'x' })))).toBe(false);
    expect(
      tarHasOnlyExpectedTag(
        p(tarOf({ 'manifest.json': JSON.stringify([{ RepoTags: ['sandbox-artifact:ci', 'victim:latest'] }]) })),
      ),
    ).toBe(false);
  });

  describe('tar の全体の走査（docker load と読み違えない）', () => {
    const p = (b: Buffer): string => {
      const f = join(dir, `${randomBytes(4).toString('hex')}.tar`);
      writeFileSync(f, b);
      return f;
    };
    const good = JSON.stringify([{ Config: `blobs/sha256/${IMAGE.slice(7)}`, RepoTags: ['sandbox-artifact:ci'], Layers: [] }]);
    const evil = JSON.stringify([{ Config: `blobs/sha256/${IMAGE.slice(7)}`, RepoTags: ['victim:latest'], Layers: [] }]);
    const pax = (records: Record<string, string>): string =>
      Object.entries(records)
        .map(([k, v]) => {
          const body = ` ${k}=${v}\n`;
          let length = body.length + 1;
          while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
          return `${length}${body}`;
        })
        .join('');
    const passes = (entries: TarEntry[]): boolean => tarHasOnlyExpectedTag(p(tarRaw(entries)));

    const FILE = `blobs/sha256/${'a'.repeat(64)}`;
    const last = { name: 'manifest.json', data: good };

    it('受ける形: docker save の OCI レイアウト（ディレクトリ、blob、index、oci-layout、manifest）', () => {
      expect(
        passes([
          { name: 'blobs/', type: '5' },
          { name: 'blobs/sha256/', type: '5' },
          { name: FILE, data: 'x' },
          { name: 'index.json', data: '{}' },
          { name: 'oci-layout', data: '{}' },
          last,
        ]),
      ).toBe(true);
    });

    it('許可リストの外の名前を拒否する（別のディレクトリ、./ 付き、.. 、絶対パス）', () => {
      for (const name of [
        'x/manifest.json',
        './manifest.json',
        '../evil',
        '/etc/evil',
        'a/../../evil',
        'evil.txt',
        `blobs/sha256/${'A'.repeat(64)}`,
      ]) {
        expect(passes([{ name, data: 'x' }, last]), name).toBe(false);
      }
    });

    it('リンク、拡張ヘッダ（PAX、GNU）、特殊な種類を拒否する', () => {
      for (const type of ['1', '2', '3', '4', '6', '7', 'x', 'g', 'L', 'K', 'S']) {
        expect(passes([{ name: FILE, type, data: type === 'x' || type === 'g' ? pax({ comment: 'x' }) : '' }, last]), type).toBe(
          false,
        );
      }
    });

    it('manifest の重複と、同じ名前の重複を拒否する', () => {
      expect(passes([last, { name: 'manifest.json', data: evil }])).toBe(false);
      expect(passes([{ name: FILE, data: 'x' }, { name: FILE, data: 'y' }, last])).toBe(false);
    });

    it('docker load と解釈が食い違う形を拒否する', () => {
      // size の先頭を NUL にすると、JS は 0、Go は実サイズと読む
      const resum = (h: Buffer): Buffer => {
        let sum = 8 * 32;
        h.forEach((b, i) => {
          if (i < 148 || i >= 156) sum += b;
        });
        h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
        return h;
      };
      const nulSize = tarEntry({ name: FILE, data: evil });
      nulSize[124] = 0;
      expect(tarHasOnlyExpectedTag(p(Buffer.concat([resum(nulSize), tarRaw([last])])))).toBe(false);
      // STAR の印と prefix
      const star = tarEntry({ name: FILE, data: 'x' });
      star.write('tar\0', 508, 'latin1');
      expect(tarHasOnlyExpectedTag(p(Buffer.concat([resum(star), tarRaw([last])])))).toBe(false);
      expect(passes([{ name: 'manifest.json', prefix: '.', data: evil }, last])).toBe(false);
      // GNU と V7 の magic
      expect(passes([{ name: FILE, data: 'b', magic: 'ustar  \0' }, last])).toBe(false);
      expect(passes([{ name: FILE, data: 'b', magic: '' }, last])).toBe(false);
      // 圧縮の形（先頭が gzip）は名前で弾く
      expect(tarHasOnlyExpectedTag(p(Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), tarRaw([last])])))).toBe(false);
    });

    it('壊れた tar と終端の後ろの項目を拒否する', () => {
      expect(passes([{ name: 'blobs/', type: '5', size: 512, data: '' }, last])).toBe(false);
      const hidden = Buffer.concat([tarRaw([last]), tarEntry({ name: 'manifest.json', data: evil }), Buffer.alloc(1024)]);
      expect(tarHasOnlyExpectedTag(p(hidden))).toBe(false);
      const bad = tarRaw([last]);
      bad[0] = 0x4d;
      expect(tarHasOnlyExpectedTag(p(bad))).toBe(false);
      expect(tarHasOnlyExpectedTag(p(tarRaw([last]).subarray(0, 600)))).toBe(false);
      expect(tarHasOnlyExpectedTag(p(Buffer.concat([tarEntry(last), Buffer.alloc(10, 1)])))).toBe(false);
    });
  });

  it('起動の引数に host mount・socket・privileged・host network・公開ポートが無い', () => {
    const args = deployRunArgs({ name: 'n', digest: IMAGE, version: HEAD });
    for (const banned of [
      '-v',
      '--volume',
      '--mount',
      '--privileged',
      '-p',
      '--publish',
      '-P',
      '--publish-all',
      '--pid',
      '--ipc',
      '--cap-add',
      '--device',
    ]) {
      expect(args).not.toContain(banned);
    }
    expect(args.join(' ')).not.toContain('docker.sock');
    expect(args.join(' ')).not.toContain('host');
    expect(args[args.indexOf('--network') + 1]).toBe('msf-devline-verify-net');
    expect(args).toContain('--read-only');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args.at(-1)).toBe(IMAGE);
  });

  it('parseLoadOutput はちょうど1つだけ受ける', () => {
    expect(parseLoadOutput('Loaded image: sandbox-artifact:ci\n')).toBe('sandbox-artifact:ci');
    expect(parseLoadOutput(`Loaded image ID: ${IMAGE}`)).toBe(IMAGE);
    expect(parseLoadOutput('Loaded image: a:1\nLoaded image: b:2')).toBeNull();
    expect(parseLoadOutput('')).toBeNull();
  });
});
