import { describe, expect, it } from 'vitest';
import {
  assertFresh,
  assessFreshness,
  buildR2Url,
  candidateManifestKeys,
  classifyEtag,
  classifyFetchError,
  classifyWranglerFailure,
  compareTocWithManifest,
  describeFailure,
  encodeObjectKey,
  formatStamp,
  isHeaderSafeToken,
  MAX_AGE_HOURS_LIMIT,
  MAX_PROBES_LIMIT,
  nextSignalAction,
  normalizePrefix,
  parseArgs,
  parseBackupKey,
  parseIsoWithZone,
  parseListingPage,
  parseManifest,
  parseStamp,
  selectLatestPair,
  tocTableCounts,
} from '../../scripts/ops/lib/offsite-recover-core.mjs';

// scripts/ops/lib/offsite-recover-core.mjs の純粋関数だけを試す。ネットワーク・R2・DB・ファイルには触らない。

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

describe('鮮度（list と guess で同じ規則）', () => {
  it('未来 10 分以内は許し、超えたら future', () => {
    expect(assessFreshness(new Date('2026-11-05T08:09:59Z'), { now: NOW }).ok).toBe(true);
    expect(assessFreshness(new Date('2026-11-05T08:10:01Z'), { now: NOW }).why).toBe('future');
  });
  it('maxAgeHours を超えたら stale、0 で無効', () => {
    const old = new Date('2026-11-04T07:59:59Z');
    expect(assessFreshness(old, { now: NOW, maxAgeHours: 24 }).why).toBe('stale');
    expect(assessFreshness(old, { now: NOW, maxAgeHours: 0 }).ok).toBe(true);
  });
  it('assertFresh は future / stale で例外、ok なら経過時間を返す', () => {
    expect(() => assertFresh('20261105T090000Z', new Date('2026-11-05T09:00:00Z'), { now: NOW })).toThrow(/未来/);
    expect(() => assertFresh('20261103T000000Z', new Date('2026-11-03T00:00:00Z'), { now: NOW, maxAgeHours: 24 })).toThrow(
      /古すぎます/,
    );
    expect(assertFresh('20261105T070000Z', new Date('2026-11-05T07:00:00Z'), { now: NOW })).toBeCloseTo(1);
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
  const obj = { key: 'k', size: 3, etag: '"abc"' };
  it('途中のページは cursor を返す（etag の引用符を落とす）', () => {
    const page = parseListingPage({ success: true, result: [obj], result_info: { is_truncated: true, cursor: 'c1' } });
    expect(page).toEqual({ objects: [{ key: 'k', size: 3, etag: 'abc' }], cursor: 'c1', needsConfirm: false });
  });
  it('is_truncated=false で cursor が無ければ最終ページ', () => {
    expect(parseListingPage({ success: true, result: [obj], result_info: { is_truncated: false } }).cursor).toBeNull();
  });
  it('result_info が無いページは最終ページ。ただし満杯なら確認が要る（needsConfirm）', () => {
    expect(parseListingPage({ success: true, result: [obj] }, { perPage: 1000 }).needsConfirm).toBe(false);
    expect(parseListingPage({ success: true, result: [] }).needsConfirm).toBe(false);
    expect(parseListingPage({ success: true, result: [obj, obj] }, { perPage: 2 }).needsConfirm).toBe(true);
  });
  it('is_truncated の型不正・cursor の矛盾は例外（最終ページ扱いにしない）', () => {
    expect(() => parseListingPage({ success: true, result: [obj], result_info: {} })).toThrow(/boolean/);
    expect(() => parseListingPage({ success: true, result: [obj], result_info: { is_truncated: 'false' } })).toThrow(/boolean/);
    expect(() => parseListingPage({ success: true, result: [obj], result_info: { is_truncated: true } })).toThrow(
      /cursor がありません/,
    );
    expect(() => parseListingPage({ success: true, result: [obj], result_info: { is_truncated: false, cursor: 'c' } })).toThrow(
      /矛盾/,
    );
    expect(() => parseListingPage({ success: true, result: [obj], result_info: { is_truncated: true, cursor: 5 } })).toThrow(
      /文字列/,
    );
    expect(() => parseListingPage({ success: true, result: [obj], result_info: [] })).toThrow(/result_info/);
  });
  it('形が違えば例外（黙って空にしない）', () => {
    expect(() => parseListingPage(null)).toThrow();
    expect(() => parseListingPage({ success: false, errors: [{ code: 10000 }] })).toThrow(/10000/);
    expect(() => parseListingPage({ success: true })).toThrow(/result/);
    expect(() => parseListingPage({ success: true, result: [{ size: 1 }] })).toThrow(/key/);
    expect(() => parseListingPage({ success: true, result: [{ key: 'k', size: -1 }] })).toThrow(/size/);
    expect(() => parseListingPage({ success: true, result: [{ key: 'k', size: 1e300 }] })).toThrow(/size/);
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
  it('同じキーの重複・関係の無いキーしか無い一覧は例外', () => {
    expect(() => selectLatestPair([...pair('20261105T060020Z'), ...pair('20261105T060020Z')], { ...scope, now: NOW })).toThrow(
      /重複/,
    );
    expect(() => selectLatestPair([{ key: 'x/y.dump', size: 1 }], { ...scope, now: NOW })).toThrow(/揃った組がありません/);
  });
  it('最新が古すぎれば例外（0 で無効）', () => {
    const objects = pair('20261103T065833Z');
    expect(() => selectLatestPair(objects, { ...scope, now: NOW, maxAgeHours: 24 })).toThrow(/古すぎます/);
    expect(selectLatestPair(objects, { ...scope, now: NOW, maxAgeHours: 0 }).stamp).toBe('20261103T065833Z');
  });
});

describe('etag の分類', () => {
  it('単一パートは MD5、"-N" 形式はマルチパート', () => {
    expect(classifyEtag('94c707ade91333e775c0bd180604dba3')).toEqual({ kind: 'md5', md5: '94c707ade91333e775c0bd180604dba3' });
    expect(classifyEtag('"94C707ADE91333E775C0BD180604DBA3"')).toEqual({ kind: 'md5', md5: '94c707ade91333e775c0bd180604dba3' });
    expect(classifyEtag('94c707ade91333e775c0bd180604dba3-12')).toEqual({ kind: 'multipart', parts: 12 });
  });
  it('欠落・不明な形は例外（照合を黙って飛ばさない）', () => {
    expect(() => classifyEtag(null)).toThrow(/ありません/);
    expect(() => classifyEtag('')).toThrow(/ありません/);
    expect(() => classifyEtag('abc')).toThrow(/不明/);
    expect(() => classifyEtag('94c707ade91333e775c0bd180604dba3-0')).toThrow(/不明/);
    expect(() => classifyEtag('94c707ade91333e775c0bd180604dba3-x')).toThrow(/不明/);
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
  it('広すぎる窓・逆順・不正な日時・不正な DB 名・範囲外の上限は例外', () => {
    const from = new Date('2026-11-05T07:00:00Z');
    expect(() => candidateManifestKeys({ ...scope, from, to: new Date('2026-11-05T08:00:00Z'), maxProbes: 900 })).toThrow(
      /広すぎます/,
    );
    expect(() => candidateManifestKeys({ ...scope, from: NOW, to: from })).toThrow(/逆順/);
    expect(() => candidateManifestKeys({ ...scope, from: new Date('x'), to: NOW })).toThrow(/日時/);
    expect(() => candidateManifestKeys({ prefix: 'p', db: 'a-b', from, to: from })).toThrow(/DB/);
    expect(() => candidateManifestKeys({ ...scope, from, to: from, maxProbes: Infinity })).toThrow(/範囲外/);
    expect(() => candidateManifestKeys({ ...scope, from, to: from, maxProbes: MAX_PROBES_LIMIT + 1 })).toThrow(/範囲外/);
  });
});

describe('wrangler の失敗の分類（stderr の本文は出さない）', () => {
  const ACCOUNT = '0123456789abcdef0123456789abcdef';
  it('キーが無い', () => {
    const f = classifyWranglerFailure({
      status: 1,
      stderr: '\x1b[31m✘ [ERROR] The specified key does not exist.\x1b[0m\nLogs were written to "/home/x/.wrangler/logs/a.log"',
    });
    expect(f.kind).toBe('not_found');
  });
  it('バケットが無い（r2 bucket info）', () => {
    const f = classifyWranglerFailure({
      status: 1,
      stderr: `A request to the Cloudflare API (/accounts/${ACCOUNT}/r2/buckets/zz) failed.\n  The specified bucket does not exist. [code: 10006]`,
    });
    expect(f).toMatchObject({ kind: 'bucket_not_found', cfCode: 10006 });
  });
  it('認証の失敗（HTTP 状態とコードだけを取り出す）', () => {
    const stderr = `Failed to fetch /accounts/${ACCOUNT}/r2/buckets/b/objects/x - 400: Bad Request;\n {"success":false,"errors":[{"code":9106,"message":"Authentication failed (status: 400)"}]}\nBearer sk-should-not-appear-0123456789`;
    const f = classifyWranglerFailure({ status: 1, stderr });
    expect(f).toMatchObject({ kind: 'auth', http: 400, cfCode: 9106, exit: 1 });
    const line = describeFailure(f);
    expect(line).toBe('kind=auth exit=1 signal=- http=400 cf_code=9106');
    expect(line).not.toContain(ACCOUNT);
    expect(line).not.toContain('accounts/');
    expect(line).not.toContain('sk-');
  });
  it('レート制限・通信・シグナル・不明', () => {
    expect(classifyWranglerFailure({ status: 1, stderr: 'status: 429 Too Many Requests' }).kind).toBe('rate_limited');
    expect(classifyWranglerFailure({ status: 1, stderr: 'TypeError: fetch failed ECONNRESET' }).kind).toBe('network');
    expect(classifyWranglerFailure({ status: null, signal: 'SIGTERM', stderr: '' })).toMatchObject({
      kind: 'signal',
      signal: 'SIGTERM',
      exit: null,
    });
    const u = classifyWranglerFailure({ status: 2, stderr: `something odd /accounts/${ACCOUNT}/` });
    expect(u.kind).toBe('unknown');
    expect(describeFailure(u)).not.toContain(ACCOUNT);
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
    expect(() => parseManifest(`#audit_tip\t${tip}\na\t${'9'.repeat(17)}\n`)).toThrow(/2 行目/);
    expect(() => parseManifest(`#audit_tip\t${tip}\na\t1\na\t2\n`)).toThrow(/重複/);
    expect(() => parseManifest(`#audit_tip\t${tip}\nb\t1\na\t2\n`)).toThrow(/昇順/);
  });
  const toc = [
    ';',
    '; Archive created at 2026-11-05',
    '215; 1259 16390 TABLE public app_user owner',
    '3500; 0 20923233 TABLE DATA public app_user owner',
    '3501; 0 20923240 TABLE DATA public audit_log owner',
    '3502; 0 20923250 TABLE DATA public request owner',
    '3503; 0 20923260 SEQUENCE SET public request_seq owner',
  ];
  it('TOC の TABLE DATA public を出現回数つきで集め、manifest と比べる', () => {
    const counts = tocTableCounts(toc.join('\n'));
    expect([...counts]).toEqual([
      ['app_user', 1],
      ['audit_log', 1],
      ['request', 1],
    ]);
    expect(compareTocWithManifest(counts, parseManifest(text).tables)).toEqual({
      ok: true,
      missing: [],
      extra: [],
      duplicate: [],
    });
    const fewer = parseManifest(`#audit_tip\t${tip}\napp_user\t3\nzz\t1\n`).tables;
    expect(compareTocWithManifest(counts, fewer)).toEqual({
      ok: false,
      missing: ['zz'],
      extra: ['audit_log', 'request'],
      duplicate: [],
    });
  });
  it('TOC に同じテーブルの TABLE DATA が重複していれば拒否する', () => {
    const dup = tocTableCounts([...toc, '3504; 0 20923270 TABLE DATA public request owner'].join('\n'));
    expect(dup.get('request')).toBe(2);
    expect(compareTocWithManifest(dup, parseManifest(text).tables)).toEqual({
      ok: false,
      missing: [],
      extra: [],
      duplicate: ['request'],
    });
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
    expect(parseArgs(['--max-age-hours', '0']).maxAgeHours).toBe(0);
    expect(parseArgs(['--max-age-hours', String(MAX_AGE_HOURS_LIMIT)]).maxAgeHours).toBe(MAX_AGE_HOURS_LIMIT);
  });
  it('巨大な数値・範囲外は例外（Infinity で上限が無効にならない）', () => {
    expect(() => parseArgs(['--max-probes', '9'.repeat(400)])).toThrow(/整数/);
    expect(() => parseArgs(['--max-age-hours', '9'.repeat(400)])).toThrow(/整数/);
    expect(() => parseArgs(['--max-probes', String(MAX_PROBES_LIMIT + 1)])).toThrow(/整数/);
    expect(() => parseArgs(['--max-probes', '0'])).toThrow(/整数/);
    expect(() => parseArgs(['--max-age-hours', String(MAX_AGE_HOURS_LIMIT + 1)])).toThrow(/整数/);
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

describe('トークンの検査と fetch の失敗（トークンを出さない）', () => {
  const TOKEN = 'T'.repeat(40);
  it('可視 ASCII 20〜512 文字だけを受ける', () => {
    expect(isHeaderSafeToken(TOKEN)).toBe(true);
    expect(isHeaderSafeToken(`${TOKEN}\n`)).toBe(false);
    expect(isHeaderSafeToken(`${TOKEN}\r\nX-Evil: 1`)).toBe(false);
    expect(isHeaderSafeToken(`${TOKEN} x`)).toBe(false);
    expect(isHeaderSafeToken(`${TOKEN}\t`)).toBe(false);
    expect(isHeaderSafeToken(`${TOKEN}\u00e9`)).toBe(false);
    expect(isHeaderSafeToken('short')).toBe(false);
    expect(isHeaderSafeToken('T'.repeat(513))).toBe(false);
    expect(isHeaderSafeToken(undefined)).toBe(false);
  });
  it('fetch の例外は名前だけで種別にし、文面（ヘッダ値）を使わない', async () => {
    // 実際の Node の fetch に改行入りのヘッダを渡すと、例外の文面にヘッダ値が載る（だから文面を使わない）
    const error = await fetch('http://127.0.0.1:9/', { headers: { Authorization: `Bearer ${TOKEN}\nX` } }).catch(
      (e: unknown) => e,
    );
    expect(String((error as Error).message)).toContain(TOKEN);
    const kind = classifyFetchError(error);
    expect(kind).toBe('network');
    expect(kind).not.toContain(TOKEN);
    expect(classifyFetchError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(classifyFetchError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('aborted');
    expect(classifyFetchError(null)).toBe('unknown');
  });
});

describe('prefix とキーと URL（パスの付け替えを防ぐ）', () => {
  const ACCOUNT = '0123456789abcdef0123456789abcdef';
  const LIST = `/client/v4/accounts/${ACCOUNT}/r2/buckets/mirai-sf-prod-backups/objects`;
  it('prefix の空・. ・.. のセグメントと使えない文字を拒否する', () => {
    expect(normalizePrefix('mirai_sf_prod')).toBe('mirai_sf_prod');
    expect(normalizePrefix('a/b.c/d-e')).toBe('a/b.c/d-e');
    for (const bad of ['a//b', 'a/./b', 'a/../b', '..', '.', 'a/..', '../a', 'a b', 'a/%2e%2e', 'a?b', 'a#b', '.hidden']) {
      expect(() => normalizePrefix(bad), bad).toThrow(/PREFIX/);
    }
  });
  it('キーのセグメントの空・. ・.. を拒否し、各セグメントを符号化する', () => {
    expect(encodeObjectKey('mirai_sf_prod/a b.dump')).toBe('mirai_sf_prod/a%20b.dump');
    expect(() => encodeObjectKey('a/../b')).toThrow();
    expect(() => encodeObjectKey('a//b')).toThrow();
    expect(() => encodeObjectKey('')).toThrow();
  });
  it('組み立てた URL は一覧・取得の期待するパスの下だけ', () => {
    const list = buildR2Url({
      accountId: ACCOUNT,
      bucket: 'mirai-sf-prod-backups',
      query: { prefix: 'mirai_sf_prod/', per_page: '1000' },
    });
    expect(list.origin).toBe('https://api.cloudflare.com');
    expect(list.pathname).toBe(LIST);
    expect(list.searchParams.get('prefix')).toBe('mirai_sf_prod/');
    const get = buildR2Url({
      accountId: ACCOUNT,
      bucket: 'mirai-sf-prod-backups',
      key: 'mirai_sf_prod/mirai_sf_prod-20261105T075022Z.dump',
    });
    expect(get.pathname).toBe(`${LIST}/mirai_sf_prod/mirai_sf_prod-20261105T075022Z.dump`);
  });
  it('キーに %2e%2e などがあっても上の階層へ出ない（符号化してキーの一部として扱う）', () => {
    const u = buildR2Url({ accountId: ACCOUNT, bucket: 'mirai-sf-prod-backups', key: 'p/%2e%2e' });
    expect(u.pathname.startsWith(`${LIST}/`)).toBe(true);
    expect(() => buildR2Url({ accountId: ACCOUNT, bucket: 'mirai-sf-prod-backups', key: 'p/../../x' })).toThrow();
  });
  it('アカウント ID・バケット名の形が違えば拒否', () => {
    expect(() => buildR2Url({ accountId: 'x', bucket: 'mirai-sf-prod-backups' })).toThrow(/アカウント/);
    expect(() => buildR2Url({ accountId: ACCOUNT, bucket: '../x' })).toThrow(/バケット/);
  });
});

describe('--from / --to の日時（タイムゾーン明示・実在する日時だけ）', () => {
  it('Z と ±HH:MM を受ける', () => {
    expect(parseIsoWithZone('2026-11-05T07:00:00Z')?.toISOString()).toBe('2026-11-05T07:00:00.000Z');
    expect(parseIsoWithZone('2026-11-05T16:00:00+09:00')?.toISOString()).toBe('2026-11-05T07:00:00.000Z');
    expect(parseIsoWithZone('2026-11-05T00:00:00-05:30')?.toISOString()).toBe('2026-11-05T05:30:00.000Z');
    expect(parseIsoWithZone('2026-11-05T07:00:00.5Z')?.toISOString()).toBe('2026-11-05T07:00:00.500Z');
    expect(parseIsoWithZone('2026-11-05T00:00:00+14:00')?.toISOString()).toBe('2026-11-04T10:00:00.000Z');
  });
  it('実在しない日時・TZ なし・範囲外のオフセットは拒否', () => {
    for (const bad of [
      '2026-02-30T00:00:00Z',
      '2026-11-05T24:00:00Z',
      '2026-11-05T07:60:00Z',
      '2026-11-05T07:00:00',
      '2026-11-05T07:00Z',
      '2026-11-05T07:00:00+14:59',
      '2026-11-05T07:00:00+15:00',
      '2026-11-05T07:00:00+09:60',
      '2026-11-05T07:00:00+0900',
      '2026-11-05 07:00:00Z',
    ]) {
      expect(parseIsoWithZone(bad), bad).toBeNull();
    }
  });
  it('オフセット適用後の UTC が 4 桁の年（0000〜9999）を外れる日時は拒否', () => {
    // UTC で 10000-01-01T13:59:59Z になる（toISOString が +010000-… の拡張形式になる）
    expect(parseIsoWithZone('9999-12-31T23:59:59-14:00')).toBeNull();
    expect(parseIsoWithZone('9999-12-31T23:59:59-00:01')).toBeNull();
    // 境界内は受ける
    expect(parseIsoWithZone('9999-12-31T23:59:59Z')?.toISOString()).toBe('9999-12-31T23:59:59.000Z');
    expect(parseIsoWithZone('9999-12-31T23:59:59+14:00')?.toISOString()).toBe('9999-12-31T09:59:59.000Z');
  });
  it('引数でも同じ規則で拒否する', () => {
    expect(() => parseArgs(['--source', 'guess', '--from', '2026-02-30T00:00:00Z'])).toThrow(/タイムゾーン/);
    expect(() => parseArgs(['--source', 'guess', '--to', '2026-11-05T07:00:00'])).toThrow(/タイムゾーン/);
    expect(() => parseArgs(['--source', 'guess', '--to', '2026-11-05T07:00:00+14:59'])).toThrow(/タイムゾーン/);
    expect(parseArgs(['--source', 'guess', '--to', '2026-11-05T16:00:00+09:00']).to?.toISOString()).toBe(
      '2026-11-05T07:00:00.000Z',
    );
  });
});

describe('manifest の件数の範囲', () => {
  it('安全な整数を超える件数は拒否する', () => {
    const tip = 'c'.repeat(64);
    expect(parseManifest(`#audit_tip\t${tip}\na\t9007199254740991\n`).tables.get('a')).toBe(9007199254740991);
    expect(() => parseManifest(`#audit_tip\t${tip}\na\t9007199254740993\n`)).toThrow(/安全な整数/);
  });
});

describe('中断シグナルの扱い', () => {
  it('1 回目は受けたシグナルを 1 回だけ転送、2 回目は SIGKILL、3 回目以降は何もしない', () => {
    let state = { first: null as string | null, escalated: false };
    let step = nextSignalAction(state, 'SIGINT');
    expect(step.action).toEqual({ kind: 'forward', signal: 'SIGINT' });
    state = step.state;
    step = nextSignalAction(state, 'SIGTERM');
    expect(step.action).toEqual({ kind: 'kill', signal: 'SIGKILL' });
    state = step.state;
    expect(nextSignalAction(state, 'SIGINT').action).toEqual({ kind: 'none' });
  });
});
