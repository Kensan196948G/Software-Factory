import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

it('injects actual approver directory only inside authenticated HTML boot', () => {
  const app = readFileSync('src/api/app.ts', 'utf8');
  const route = app.slice(app.indexOf("app.get('/',"), app.indexOf("app.get('/login'"));
  expect(route.indexOf('if (!ctx)')).toBeLessThan(route.indexOf('approvers: await listApprovers()'));
  expect(route).toContain('approvers: await listApprovers()');
  expect(app).toContain("app.get('/api/approvers'");
});
