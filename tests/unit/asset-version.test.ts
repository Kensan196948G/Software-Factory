import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { versionAssets } from '../../src/api/asset-version.js';

describe('スクリプト・CSS の URL の版', () => {
  it('実際の画面のスクリプトと CSS に版が付き、版の無い参照が残らない', () => {
    const html = versionAssets(readFileSync(resolve(process.cwd(), 'src/web/index.html'), 'utf8'), 'abc123');
    expect(html).toContain('<script src="/station-bridge.js?v=abc123"></script>');
    expect(html).toContain('<script src="/station.js?v=abc123"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/station.css?v=abc123">');
    expect(html).not.toMatch(/src="\/(bridge|console|station-bridge|station)\.js"/);
    expect(html).not.toMatch(/href="\/station\.css"/);
  });

  it('旧画面のスクリプトにも版を付ける（切り戻し用に残す）', () => {
    expect(versionAssets('<script src="/console.js"></script>', 'v1')).toBe(
      '<script src="/console.js?v=v1"></script>',
    );
  });

  it('版の文字列は URL として安全にする', () => {
    expect(versionAssets('<script src="/station.js"></script>', 'a"><b')).toBe(
      '<script src="/station.js?v=a%22%3E%3Cb"></script>',
    );
  });
});
