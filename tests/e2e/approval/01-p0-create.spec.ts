import { expect, test, IS_ISO } from './fixtures/roles';
import { cancelRequest, currentUser, registerRequest, serverRequest, uniqueTitle } from './fixtures/station';
import { recordRequest } from './fixtures/run-state';

/**
 * A1（ステップ1）: 一般利用者が 7 ステップで登録すると受付番号が出て、再読み込みしても 1 件残る。
 * 対象: 層①②③。
 */
test(
  'A1 一般利用者の登録で受付番号が出て、再読み込みしても1件残る',
  { tag: ['@iso', '@otp', '@prod-smoke'] },
  async ({ user, admin, db }) => {
    const requester = await currentUser(user.api);
    const approver = await currentUser(admin.api);
    const title = uniqueTitle('A1 登録');
    let id = '';

    try {
      const created = await registerRequest(user.page, { title, decides: 'g', approverUserId: approver.id });
      id = created.id;

      expect(id, '受付番号の形が違う').toMatch(/^REQ-\d{4}-\d{4}$/);
      expect(created.toast, '受付のトーストが出ていない').toContain('受け付けました');
      recordRequest(id, 'A1');

      const row = await serverRequest(user.api, id);
      expect(row.title).toBe(title);
      expect(row.status).toBe('received');
      expect(row.version).toBe(1);
      expect(row.applicantUserId, '起票者が一般利用者ではない').toBe(requester.id);
      expect(row.approverUserId, '承認者が管理者ではない').toBe(approver.id);

      // 再読み込みしても、同じ受付番号の依頼が 1 件だけ残る（画面）。
      await user.page.reload();
      await user.page.waitForSelector('#nav', { timeout: 30_000 });
      await user.page.click('#nav a[data-v="list"]');
      await user.page.waitForSelector('#ltb tr[data-id]');
      await user.page.fill('#main [data-flt="fq"]', id);
      await expect(user.page.locator(`#ltb tr[data-id="${id}"]`)).toHaveCount(1, { timeout: 20_000 });
      await expect(user.page.locator(`#ltb tr[data-id="${id}"]`)).toContainText(title);

      // サーバ側も同じ依頼が 1 件だけ。
      const list = await user.api.get(`/api/requests?q=${encodeURIComponent(title)}&pageSize=100`);
      expect(list.status).toBe(200);
      const sameTitle = (list.body.items as { id: string; title: string }[]).filter((x) => x.title === title);
      expect(sameTitle, '同じ件名の依頼が 1 件ではない').toHaveLength(1);
      expect(sameTitle[0]?.id).toBe(id);

      // 層①だけは DB 直読でも 1 行であることを確かめる（DB を持たない層②③では行わない）。
      if (db) {
        const rows = await db.query('select id, status, version from request where title = $1', [title]);
        expect(rows, 'DB に同じ依頼が 1 行ではない').toHaveLength(1);
        expect(rows[0]?.id).toBe(id);
      }
    } finally {
      // 層②③は本番・Staging を汚さないよう、理由を付けて取消す（削除はしない）。
      if (!IS_ISO && id) {
        await cancelRequest(admin.api, id, '検証（A1）で作った作り物の依頼のため、確認後に取消').catch(() => undefined);
      }
    }
  },
);
