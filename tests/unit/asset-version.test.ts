import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { versionAssets } from '../../src/api/asset-version.js';

describe('スクリプトの URL の版', () => {
  it('実際の画面の両方のスクリプトに版が付き、版の無い参照が残らない', () => {
    const html = versionAssets(readFileSync(resolve(process.cwd(), 'src/web/index.html'), 'utf8'), 'abc123');
    expect(html).toContain('<script src="/bridge.js?v=abc123"></script>');
    expect(html).toContain('<script src="/console.js?v=abc123"></script>');
    expect(html).not.toMatch(/src="\/(bridge|console)\.js"/);
  });

  it('版の文字列は URL として安全にする', () => {
    expect(versionAssets('<script src="/console.js"></script>', 'a"><b')).toBe(
      '<script src="/console.js?v=a%22%3E%3Cb"></script>',
    );
  });
});
