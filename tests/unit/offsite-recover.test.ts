import { describe, expect, it } from 'vitest';
import {
  candidateManifestKeys,
  compareTocWithManifest,
  formatStamp,
  md5FromEtag,
  normalizePrefix,
  parseArgs,
  parseBackupKey,
  parseListingPage,
  parseManifest,
  parseStamp,
  selectLatestPair,
  tocTableNames,
} from '../../scripts/ops/offsite-recover.mjs';

// scripts/ops/offsite-recover.mjs の純粋関数だけを試す。ネットワーク・R2・DB・ファイルには触らない。

const scope = { prefix: 'mirai_sf_prod', db: 'mirai_sf_prod' };
const NOW = new Date('2026-11-05T08:00:00Z');
const key = (stamp: string, kind: 'dump' | 'manifest.tsv') => `mirai_sf_prod/mirai_sf_prod-${stamp}.${kind}`;
const pair = (stamp: string, size = 100) => [
  { key: key(stamp, 'dump'), size, etag: 'a'.repeat(32) },
  { key: key(stamp, 'manifest.tsv'), size: 10, etag: 'b'.repeat(32) },
];

describe('時刻の解釈', () => {
  it('YYYYMMDDTHHMMSSZ を往復できる', () => {
    const d = parseStamp('20261105T075022Z');
    expect(d?.toISOString()).toBe('2026-11-05T07:50:22.000Z');
    expect(formatStamp(d as Date)).toBe('20261105T075022Z');
  });
  it('実在しない日時や形の違いは null', () => {
    expect(parseStamp('20261131T000000Z')).toBeNull();
    expect(parseStamp('20261105T246000Z')).toBeNull();
    expect(parseStamp('20261105T0750Z')).toBeNull();
    expect(parseStamp('20261105075022Z')).toBeNull();
  });
  it('prefix の前後の / を落とす', () => {
    expect(normalizePrefix('/a/b/')).toBe('a/b');
    expect(normalizePrefix(undefined)).toBe('');
  });
});

describe('キーの解釈', () => {
  it('dump と manifest を受ける', () => {
    expect(parseBackupKey(key('20261105T075022Z', 'dump'), scope)?.kind).toBe('dump');
    expect(parseBackupKey(key('20261105T075022Z', 'manifest.tsv'), scope)?.kind).toBe('manifest');
  });
  it('別 prefix・別 DB・手動の名前・送信記録は受けない', () => {
    expect(parseBackupKey('other/mirai_sf_prod-20261105T075022Z.dump', scope)).toBeNull();
    expect(parseBackupKey('mirai_sf_prod/mirai_sf_dev-20261105T075022Z.dump', scope)).toBeNull();
    expect(parseBackupKey('mirai_sf_prod/mirai_sf_prod-manual.dump', scope)).toBeNull();
    expect(parseBackupKey('mirai_sf_prod/mirai_sf_prod-20261105T075022Z.dump.r2.json', scope)).toBeNull();
    expect(parseBackupKey('mirai_sf_prod/sub/mirai_sf_prod-20261105T075022Z.dump', scope)).toBeNull();
    expect(parseBackupKey(42, scope)).toBeNull();
  });
  it('prefix が空ならバケット直下を対象にする', () => {
    expect(parseBackupKey('mirai_sf_prod-20261105T075022Z.dump', { prefix: '', db: 'mirai_sf_prod' })?.stamp).toBe(
      '20261105T075022Z',
    );
  });
});

describe('一覧の応答', () => {
  it('結果と cursor を取り出す（etag の引用符を落とす）', () => {
    const page = parseListingPage({
      success: true,
      result: [{ key: 'k', size: 3, etag: '"abc"' }],
      result_info: { is_truncated: true, cursor: 'c1' },
    });
    expect(page).toEqual({ objects: [{ key: 'k', size: 3, etag: 'abc' }], cursor: 'c1' });
    expect(parseListingPage({ success: true, result: [], result_info: { is_truncated: false } }).cursor).toBeNull();
  });
  it('形が違えば例外（黙って空にしない）', () => {
    expect(() => parseListingPage(null)).toThrow();
    expect(() => parseListingPage({ success: false, errors: [{ code: 10000 }] })).toThrow(/10000/);
    expect(() => parseListingPage({ success: true })).toThrow(/result/);
    expect(() => parseListingPage({ success: true, result: [{ size: 1 }] })).toThrow(/key/);
    expect(() => parseListingPage({ success: true, result: [{ key: 'k', size: -1 }] })).toThrow(/size/);
    expect(() => parseListingPage({ success: true, result: [], result_info: { is_truncated: true } })).toThrow(/cursor/);
  });
});

describe('最新の組の選択', () => {
  it('dump と manifest が揃った最新を選ぶ', () => {
    const objects = [...pair('20261105T060020Z'), ...pair('20261105T075022Z'), ...pair('20261105T073541Z')];
    const pick = selectLatestPair(objects, { ...scope, now: NOW });
    expect(pick.stamp).toBe('20261105T075022Z');
    expect(pick.dump.key).toBe(key('20261105T075022Z', 'dump'));
    expect(pick.manifest.key).toBe(key('20261105T075022Z', 'manifest.tsv'));
    expect(pick.considered).toBe(3);
  });
  it('manifest の無い新しい dump・空のもの・未来の時刻は飛ばす', () => {
    const objects = [
      ...pair('20261105T060020Z'),
      { key: key('20261105T070000Z', 'dump'), size: 100 },
      ...pair('20261105T071000Z', 0),
      ...pair('20261105T120000Z'),
      { key: key('20261105T072000Z', 'manifest.tsv'), size: 10 },
    ];
    const pick = selectLatestPair(objects, { ...scope, now: NOW });
    expect(pick.stamp).toBe('20261105T060020Z');
    expect(pick.skipped.map((s) => s.why)).toEqual(['future', 'no-dump', 'empty', 'no-manifest']);
  });
  it('関係の無いキーしか無ければ例外', () => {
    expect(() => selectLatestPair([{ key: 'x/y.dump', size: 1 }], { ...scope, now: NOW })).toThrow(/揃った組がありません/);
  });
  it('最新が古すぎれば例外（0 で無効）', () => {
    const objects = pair('20261103T065833Z');
    expect(() => selectLatestPair(objects, { ...scope, now: NOW, maxAgeHours: 24 })).toThrow(/古すぎます/);
    expect(selectLatestPair(objects, { ...scope, now: NOW, maxAgeHours: 0 }).stamp).toBe('20261103T065833Z');
  });
});

describe('キーの推定（一覧が使えないとき）', () => {
  it('窓の中を新しい順に 1 秒刻みで作る', () => {
    const keys = candidateManifestKeys({
      ...scope,
      from: new Date('2026-11-05T07:50:20Z'),
      to: new Date('2026-11-05T07:50:22.900Z'),
    });
    expect(keys).toEqual([
      key('20261105T075022Z', 'manifest.tsv'),
      key('20261105T075021Z', 'manifest.tsv'),
      key('20261105T075020Z', 'manifest.tsv'),
    ]);
  });
  it('広すぎる窓・逆順・不正な日時・不正な DB 名は例外', () => {
    const from = new Date('2026-11-05T07:00:00Z');
    expect(() => candidateManifestKeys({ ...scope, from, to: new Date('2026-11-05T08:00:00Z'), maxProbes: 900 })).toThrow(
      /広すぎます/,
    );
    expect(() => candidateManifestKeys({ ...scope, from: NOW, to: from })).toThrow(/逆順/);
    expect(() => candidateManifestKeys({ ...scope, from: new Date('x'), to: NOW })).toThrow(/日時/);
    expect(() => candidateManifestKeys({ prefix: 'p', db: 'a-b', from, to: from })).toThrow(/DB/);
  });
});

describe('manifest と dump の整合', () => {
  const tip = 'c'.repeat(64);
  const text = `#audit_tip\t${tip}\napp_user\t3\naudit_log\t10\nrequest\t0\n`;
  it('監査ハッシュとテーブルの件数を読む', () => {
    const m = parseManifest(text);
    expect(m.auditTip).toBe(tip);
    expect([...m.tables]).toEqual([
      ['app_user', 3],
      ['audit_log', 10],
      ['request', 0],
    ]);
    expect(parseManifest('#audit_tip\t\nrequest\t1\n').auditTip).toBe('');
  });
  it('形の違う manifest は例外', () => {
    expect(() => parseManifest('#audit_tip\t' + tip + '\n')).toThrow(/短すぎ/);
    expect(() => parseManifest('#tip\tx\na\t1\n')).toThrow(/先頭/);
    expect(() => parseManifest(`#audit_tip\t${tip}\na\t01\n`)).toThrow(/2 行目/);
    expect(() => parseManifest(`#audit_tip\t${tip}\na\t1\na\t2\n`)).toThrow(/重複/);
    expect(() => parseManifest(`#audit_tip\t${tip}\nb\t1\na\t2\n`)).toThrow(/昇順/);
  });
  it('TOC の TABLE DATA public だけを集め、manifest と比べる', () => {
    const toc = [
      ';',
      '; Archive created at 2026-11-05',
      '215; 1259 16390 TABLE public app_user owner',
      '3500; 0 20923233 TABLE DATA public app_user owner',
      '3501; 0 20923240 TABLE DATA public audit_log owner',
      '3502; 0 20923250 TABLE DATA public request owner',
      '3503; 0 20923260 SEQUENCE SET public request_seq owner',
    ].join('\n');
    const names = tocTableNames(toc);
    expect([...names].sort()).toEqual(['app_user', 'audit_log', 'request']);
    expect(compareTocWithManifest(names, parseManifest(text).tables)).toEqual({ ok: true, missing: [], extra: [] });
    const fewer = parseManifest(`#audit_tip\t${tip}\napp_user\t3\nzz\t1\n`).tables;
    expect(compareTocWithManifest(names, fewer)).toEqual({ ok: false, missing: ['zz'], extra: ['audit_log', 'request'] });
  });
  it('単一パートの etag だけを MD5 として使う', () => {
    expect(md5FromEtag('94c707ade91333e775c0bd180604dba3')).toBe('94c707ade91333e775c0bd180604dba3');
    expect(md5FromEtag('94c707ade91333e775c0bd180604dba3-2')).toBeNull();
    expect(md5FromEtag(null)).toBeNull();
  });
});

describe('引数', () => {
  it('既定値と指定', () => {
    expect(parseArgs([])).toMatchObject({ source: 'list', verifyOnly: false, maxAgeHours: 24, maxProbes: 3601 });
    const o = parseArgs([
      '--source',
      'guess',
      '--from',
      '2026-11-05T07:00:00Z',
      '--to',
      '2026-11-05T07:10:00Z',
      '--verify-only',
      '--max-probes',
      '601',
    ]);
    expect(o.source).toBe('guess');
    expect(o.verifyOnly).toBe(true);
    expect(o.from?.toISOString()).toBe('2026-11-05T07:00:00.000Z');
    expect(o.maxProbes).toBe(601);
  });
  it('誤りは例外', () => {
    expect(() => parseArgs(['--source', 's3'])).toThrow();
    expect(() => parseArgs(['--max-age-hours', '-1'])).toThrow();
    expect(() => parseArgs(['--from', 'yesterday', '--source', 'guess'])).toThrow();
    expect(() => parseArgs(['--from', '2026-11-05T07:00:00Z'])).toThrow(/guess/);
    expect(() => parseArgs(['--out'])).toThrow();
    expect(() => parseArgs(['--bogus'])).toThrow();
  });
});
