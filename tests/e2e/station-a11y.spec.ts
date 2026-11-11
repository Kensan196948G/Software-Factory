import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * ステーション画面のアクセシビリティ自動検査（実サーバ・実データ）。
 * serious / critical だけを失敗にする（moderate / minor は記録しない）。
 * 既知の除外は「ルール + 対象要素」で最小に絞り、理由を docs/design/station-ui.md に残す。
 */

const KNOWN_EXCLUSIONS: { rule: string; target: string | RegExp; reason: string }[] = [];

function remaining(violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']) {
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => {
      const allowed = (target: readonly unknown[]) =>
        KNOWN_EXCLUSIONS.some((e) => {
          const joined = target.join(' ');
          return e.rule === v.id && (typeof e.target === 'string' ? joined === e.target : e.target.test(joined));
        });
      return { ...v, nodes: v.nodes.filter((n) => !allowed(n.target)) };
    })
    .filter((v) => v.nodes.length > 0);
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => {
      const end = a.effect?.getComputedTiming().endTime;
      return typeof end === 'number' && Number.isFinite(end);
    });
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  await page.waitForTimeout(120);
}

const VIEWS: [string, string][] = [
  ['dash', 'ダッシュボード'],
  ['review', '確認・承認'],
  ['board', 'ボード'],
  ['list', '一覧'],
  ['catalog', '道具カタログ'],
  ['devops', 'DevOps'],
  ['secops', 'SecOps'],
  ['log', '監査ログ'],
  ['settings', 'システム設定'],
];

test('主要画面に重大なアクセシビリティ違反がない', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#nav');
  const failures: string[] = [];
  for (const [view, label] of VIEWS) {
    await page.click(`#nav a[data-v="${view}"]`);
    await settle(page);
    await expect(page.locator('#main')).toContainText(label);
    const result = await new AxeBuilder({ page }).analyze();
    const left = remaining(result.violations);
    if (left.length) {
      failures.push(
        `[${view}] ` +
          left
            .map(
              (v) =>
                `${v.id} (${v.impact}): ${v.help}\n` +
                v.nodes.map((n) => `  - ${n.target.join(' ')}\n    ${(n.failureSummary || '').split('\n').join(' / ')}`).join('\n'),
            )
            .join('\n'),
      );
    }
  }
  expect(failures.join('\n\n')).toBe('');
});

test('狭い画面でも重大な違反がない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.waitForSelector('#nav');
  await settle(page);
  const result = await new AxeBuilder({ page }).analyze();
  expect(remaining(result.violations).map((v) => v.id + ':' + v.help)).toEqual([]);
});
