import { chmodSync } from 'node:fs';
import { request, type Page } from '@playwright/test';
import { expect, IS_ISO, test, USER_EMAIL, USER_PASSWORD, USER_STATE } from './fixtures/roles';
import {
  auditLogs,
  createRequestViaApi,
  currentUser,
  loginWithPassword,
  openApp,
  openFromReview,
  serverRequest,
  transitionViaApi,
  uniqueTitle,
} from './fixtures/station';
import { recordRequest } from './fixtures/run-state';

/**
 * B（P1 画面系）: 2 アカウント運用の「取り違え・権限・失効」を画面と API の両面から実測する。
 * 対象: 層①のみ（@iso）。
 *
 * 実測する事実だけを書き、期待と実装が違えばテストを緩めずに FAIL として残す。
 * 5xx と pageerror は共通フィクスチャ（roles.ts）が 0 件を検査する。4xx は拒否の実測値。
 *
 * 実データ・メール・個人情報は使わない。メールとパスワードは環境変数からのみ読み、出力しない。
 */

/** 同時承認の送信結果（page 内の fetch から返す最小限の形）。 */
interface TransitionProbe {
  status: number;
  code: string | null;
  finalStatus: string | null;
}

/** 管理者の同じセッション（Cookie 共有）の 2 ページから、同じ版で承認を同時に送る。 */
async function postApproval(page: Page, requestId: string, version: number): Promise<TransitionProbe> {
  return page.evaluate(
    async ({ id, expectedVersion }) => {
      const csrfRes = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
      const csrfBody = (await csrfRes.json()) as { csrf?: string | null };
      const res = await fetch(`/api/requests/${encodeURIComponent(id)}/transitions`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': String(csrfBody.csrf ?? ''),
        },
        body: JSON.stringify({
          to: 'approved',
          signal: 'g',
          version: expectedVersion,
          checklistAcknowledged: true,
          redAcknowledged: true,
        }),
      });
      const text = await res.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return {
        status: res.status,
        code: (body?.error?.code as string | undefined) ?? null,
        finalStatus: (body?.detail?.status as string | undefined) ?? null,
      };
    },
    { id: requestId, expectedVersion: version },
  );
}

test(
  'B1 同じ依頼を2つのタブから同時に承認すると片方だけが成立する',
  { tag: ['@iso'] },
  async ({ admin, user, recorder, evidence }) => {
    expect(IS_ISO, 'B1 は層①（隔離環境）だけで実行する').toBe(true);

    const requester = await currentUser(user.api);
    const approver = await currentUser(admin.api);
    const title = uniqueTitle('B1 同時承認');

    // 準備: 一般利用者が API で依頼を作り、管理者が「承認待ち」まで進める（ここは判定ではない）。
    const created = await createRequestViaApi(user.api, {
      title,
      decides: 'g',
      approverUserId: approver.id,
      approverName: approver.displayName,
      applicant: requester.displayName,
    });
    const id = created.id;
    recordRequest(id, 'B1');
    expect(id, '受付番号の形が違う').toMatch(/^REQ-\d{4}-\d{4}$/);

    await transitionViaApi(admin.api, id, 'review');
    await transitionViaApi(admin.api, id, 'wait');
    const before = await serverRequest(admin.api, id);
    expect(before.status, '同時承認の前に「承認待ち」になっていない').toBe('wait');
    expect(before.approverUserId, '承認者が管理者ではない').toBe(approver.id);

    // 同じ管理者セッションの 2 ページで、同じ依頼を画面から開く。
    const pages = await Promise.all([admin.context.newPage(), admin.context.newPage()]);
    try {
      for (const page of pages) page.on('pageerror', (error) => recorder.pageErrors.push(error.message));
      // 新しいページは空なので、先にアプリを開いてから同じ依頼を詳細パネルで開く。
      await Promise.all(
        pages.map(async (page) => {
          await openApp(page);
          await openFromReview(page, id);
        }),
      );

      // 両ページが同じ版を持っていることを確かめてから、Promise.all で同時に送る。
      const version = before.version;
      const results = await Promise.all(pages.map((page) => postApproval(page, id, version)));

      const statuses = results.map((r) => r.status).sort((a, b) => a - b);
      expect(statuses, `200 と 409 に分かれない（実測: ${JSON.stringify(results)}）`).toEqual([200, 409]);

      const accepted = results.find((r) => r.status === 200);
      const denied = results.find((r) => r.status === 409);
      expect(accepted, '200 の応答が無い').toBeTruthy();
      expect(denied, '409 の応答が無い').toBeTruthy();
      expect(
        ['ERR-301', 'ERR-201'],
        `拒否が版競合（ERR-301）でも二重承認拒否（ERR-201）でもない（実測: ${String(denied?.code)}）`,
      ).toContain(denied?.code);

      // サーバの最終状態は「承認済み」1 つだけ。版は 1 回分だけ進む。
      const after = await serverRequest(admin.api, id);
      expect(after.status, '同時承認後の状態が承認済みではない').toBe('approved');
      expect(after.version, '同時承認で版が 1 回分だけ進んでいない').toBe(version + 1);
      expect(after.orderVersion, '注文書の版が 1 になっていない').toBe(1);
      expect(after.signalDecided, '決定した信号の色が青（g）ではない').toBe('g');

      // 拒否は監査に残る（誰が・どの依頼を・なぜ拒否したか）。
      const logs = await auditLogs(admin.api, 500);
      const deniedLogs = logs.items.filter(
        (entry) =>
          entry.targetId === id &&
          entry.result === 'denied' &&
          (entry.action === 'request.transition_denied' || entry.action === 'approval.duplicate_denied'),
      );
      expect(
        deniedLogs.length,
        '同時承認の拒否が監査（request.transition_denied / approval.duplicate_denied）に残っていない',
      ).toBeGreaterThan(0);
      const transitioned = logs.items.filter(
        (entry) => entry.targetId === id && entry.action === 'request.transition' && entry.result === 'success',
      );
      expect(transitioned.length, '成立した承認が監査（request.transition）に残っていない').toBeGreaterThan(0);

      evidence.note('B1', {
        requestId: id,
        versionBefore: version,
        responses: results,
        statuses,
        deniedCodes: denied ? [denied.code] : [],
        finalStatus: after.status,
        finalVersion: after.version,
        orderVersion: after.orderVersion,
        signalDecided: after.signalDecided,
        auditDenied: deniedLogs.map((entry) => ({ action: entry.action, result: entry.result })),
        auditTransitionSuccess: transitioned.length,
      });
    } finally {
      for (const page of pages) await page.close().catch(() => undefined);
    }
  },
);

test(
  'B2 一般利用者は監査ログを取得できず、持っていない役割へ切り替えられない',
  { tag: ['@iso'] },
  async ({ user, recorder, evidence }) => {
    expect(IS_ISO, 'B2 は層①（隔離環境）だけで実行する').toBe(true);

    const meBefore = await user.api.get('/api/auth/me');
    expect(meBefore.status, '一般利用者のセッションが有効ではない').toBe(200);
    expect(meBefore.body?.user?.actingRole, '開始時の操作する人が requester ではない').toBe('requester');

    // API: 監査ログ（管理者だけ）は 403 ERR-101。
    const audit = await user.api.get('/api/audit-logs?limit=5');
    expect(audit.status, '一般利用者が監査ログを取得できてしまう').toBe(403);
    expect(audit.body?.error?.code, '監査ログ拒否のエラーコードが ERR-101 ではない').toBe('ERR-101');

    // API: 保持していない役割（approver）への切替は 403 ERR-101。サーバの actingRole は変わらない。
    const switched = await user.api.post('/api/auth/role', { role: 'approver' });
    expect(switched.status, '一般利用者が承認者へ切り替えられてしまう').toBe(403);
    expect(switched.body?.error?.code, '役割切替拒否のエラーコードが ERR-101 ではない').toBe('ERR-101');

    const meAfter = await user.api.get('/api/auth/me');
    expect(meAfter.status, '役割切替の拒否後にセッションが壊れている').toBe(200);
    expect(meAfter.body?.user?.actingRole, '役割切替の拒否後もサーバの操作する人が要求者ではない').toBe('requester');
    expect(meAfter.body?.user?.roles, '一般利用者の保持する役割が requester だけではない').toEqual(['requester']);

    // 画面: 起動時に監査ログ（管理者だけ）を取得しにいき、403 で拒否される。
    // 5xx にはせず、4xx として共通フィクスチャの記録にだけ残ることを確かめる。
    await openApp(user.page);
    await expect
      .poll(() => recorder.http.filter((entry) => entry.status === 403 && /\/api\/audit-logs/.test(entry.url)).length, {
        timeout: 20_000,
        message: '画面からの監査ログ取得が 403 にならない',
      })
      .toBeGreaterThan(0);

    // 画面の「操作する人」には、保持している requester だけが出る（保持していない役割を選べない）。
    await user.page.waitForSelector('#role', { timeout: 20_000 });
    const roleOptions = await user.page
      .locator('#role option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(roleOptions, `画面の役割の選択肢が requester だけではない（実測: ${JSON.stringify(roleOptions)}）`).toEqual([
      'requester',
    ]);

    // 監査ログ画面は開けるが、サーバの記録（管理者だけ）は混ざらない。画面は壊れない。
    await user.page.click('#nav a[data-v="log"]');
    await expect(user.page.locator('#main')).toContainText('監査ログ', { timeout: 15_000 });

    const audit4xx = recorder.http.filter((entry) => entry.status === 403 && /\/api\/audit-logs/.test(entry.url));
    evidence.note('B2', {
      apiAuditLogs: { status: audit.status, code: audit.body?.error?.code ?? null },
      apiRoleSwitch: { status: switched.status, code: switched.body?.error?.code ?? null },
      actingRoleBefore: meBefore.body?.user?.actingRole ?? null,
      actingRoleAfter: meAfter.body?.user?.actingRole ?? null,
      roles: meAfter.body?.user?.roles ?? [],
      uiAuditLogs403: audit4xx.length,
      uiRoleOptions: roleOptions,
    });
  },
);

test(
  'B3 管理者が利用者を無効化するとセッションと再ログインが失効し、有効化で回復する',
  { tag: ['@iso'] },
  async ({ admin, user, browser, baseURL, evidence }) => {
    expect(IS_ISO, 'B3 は層①（隔離環境）だけで実行する').toBe(true);

    const requester = await currentUser(user.api);
    let targetId = requester.id;
    const observed: {
      listStatus?: number;
      managedIsActiveBefore?: boolean;
      deactivateStatus?: number;
      isActiveAfterDeactivate?: boolean;
      meWhileInactive?: { status: number; code: string | null };
      reloginWhileInactive?: { status: number; code: string | null };
      activateStatus?: number;
      isActiveAfterActivate?: boolean;
      reloginAfterActivate?: { status: number; actingRole: string | null };
      savedState?: { status: number; actingRole: string | null };
    } = {};

    try {
      // 管理者 API で一般利用者の id を引く（メールは突き合わせにだけ使い、出力しない）。
      const list = await admin.api.get('/api/admin/users');
      observed.listStatus = list.status;
      expect(list.status, '管理者が利用者一覧を取得できない').toBe(200);
      const managed = (list.body.items as { id: string; email: string; isActive: boolean }[]).find(
        (item) => item.email.toLowerCase() === USER_EMAIL.toLowerCase(),
      );
      expect(managed, '一般利用者が利用者一覧に居ない').toBeTruthy();
      targetId = managed!.id;
      observed.managedIsActiveBefore = managed!.isActive;
      expect(managed!.isActive, '無効化の前から一般利用者が無効になっている').toBe(true);

      // 無効化。既存セッションは失効し、再ログインも 401 になる。
      const off = await admin.api.patch(`/api/admin/users/${encodeURIComponent(targetId)}`, { isActive: false });
      observed.deactivateStatus = off.status;
      expect(off.status, '一般利用者を無効化できない').toBe(200);
      observed.isActiveAfterDeactivate = off.body?.user?.isActive;
      expect(off.body?.user?.isActive, '無効化後も isActive が true のまま').toBe(false);

      const me = await user.api.get('/api/auth/me');
      observed.meWhileInactive = { status: me.status, code: me.body?.error?.code ?? null };
      expect(me.status, '無効化された利用者の既存セッションが失効していない').toBe(401);
      expect(me.body?.error?.code, '既存セッションの失効が ERR-106 ではない').toBe('ERR-106');

      const probe = await request.newContext({ baseURL });
      try {
        const login = await probe.post('/api/auth/login', {
          data: { email: USER_EMAIL, password: USER_PASSWORD },
          failOnStatusCode: false,
        });
        const loginBody = await login.json().catch(() => null);
        observed.reloginWhileInactive = { status: login.status(), code: loginBody?.error?.code ?? null };
        expect(login.status(), '無効化された利用者のパスワード再ログインが通ってしまう').toBe(401);
      } finally {
        await probe.dispose();
      }
    } finally {
      // 何があっても有効に戻す（次のテスト・次の繰り返しを壊さない）。
      const on = await admin.api.patch(`/api/admin/users/${encodeURIComponent(targetId)}`, { isActive: true });
      observed.activateStatus = on.status;
      observed.isActiveAfterActivate = on.body?.user?.isActive;
      expect(on.status, '無効化した利用者を有効に戻せない').toBe(200);
      expect(on.body?.user?.isActive, '有効化後も isActive が false のまま').toBe(true);

      // パスワードで再ログインし、次の繰り返しが使う storageState を作り直す（0600）。
      const session = await loginWithPassword(browser, USER_EMAIL, USER_PASSWORD);
      try {
        await session.context.storageState({ path: USER_STATE });
        chmodSync(USER_STATE, 0o600);

        const me = await session.context.request.get('/api/auth/me');
        const meBody = await me.json().catch(() => null);
        observed.reloginAfterActivate = { status: me.status(), actingRole: meBody?.user?.actingRole ?? null };
        expect(me.status(), '再有効化後のログインが通っていない').toBe(200);
        expect(meBody?.user?.actingRole, '再有効化後の操作する人が requester ではない').toBe('requester');

        // 保存した storageState がそのまま次のログインに使えることを確かめる。
        const saved = await request.newContext({ baseURL, storageState: USER_STATE });
        try {
          const savedMe = await saved.get('/api/auth/me');
          const savedBody = await savedMe.json().catch(() => null);
          observed.savedState = { status: savedMe.status(), actingRole: savedBody?.user?.actingRole ?? null };
          expect(savedMe.status(), '保存した storageState でログインできない').toBe(200);
          expect(savedBody?.user?.actingRole, '保存した storageState の操作する人が requester ではない').toBe('requester');
        } finally {
          await saved.dispose();
        }
      } finally {
        await session.context.close();
      }

      evidence.note('B3', { userId: targetId, ...observed });
    }
  },
);
