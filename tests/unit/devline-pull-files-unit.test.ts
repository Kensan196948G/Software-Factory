import { expect, it } from 'vitest';
import { parsePullFiles } from '../../src/worker/github-ci-collector.js';

// 実環境の GitHub REST `GET /repos/{repo}/pulls/{n}/files` は**配列**を返す。
// 以前の実装は `{ files: [...] }` を期待していたため、実 runner の verifying が
// 常に retry になり進まなかった（2026-11-19 に実測）。ここで両方の形を固定する。
it('配列（実 GitHub の形）から変更ファイルを読む', () => {
  const parsed = parsePullFiles([
    { filename: 'src/index.js', status: 'modified' },
    { filename: 'test/unit/count-chars.test.js', status: 'added' },
    { filename: 'old.js', status: 'removed' },
  ]);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.changedFiles.has('src/index.js')).toBe(true);
  expect(parsed.changedFiles.has('test/unit/count-chars.test.js')).toBe(true);
  expect(parsed.changedFiles.has('old.js')).toBe(false);
  expect(parsed.count).toBe(3);
});

it('object（旧テストの形）も読める', () => {
  const parsed = parsePullFiles({ files: [{ filename: 'a.ts', status: 'modified' }] });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect([...parsed.changedFiles]).toEqual(['a.ts']);
});

it('配列でも object でもない応答は retry（通信のやり直し）', () => {
  expect(parsePullFiles(null)).toEqual({ ok: false, reason: 'retry' });
  expect(parsePullFiles({ message: 'Not Found' })).toEqual({ ok: false, reason: 'retry' });
});

it('要素の形が違う応答は invalid（証跡の欠落として扱う）', () => {
  expect(parsePullFiles([{ status: 'modified' }])).toEqual({ ok: false, reason: 'invalid' });
  expect(parsePullFiles(['src/index.js'])).toEqual({ ok: false, reason: 'invalid' });
});
