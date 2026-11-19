import { expect, test, IS_ISO, type Api } from './fixtures/roles';
import {
  approveViaUi,
  auditLogs,
  cancelRequest,
  closeModal,
  createRequestViaApi,
  currentUser,
  lastToast,
  openApp,
  openFromReview,
  serverRequest,
  submitStatus,
  uniqueTitle,
  waitStatus,
  type ServerRequest,
  type Status,
} from './fixtures/station';
import { recordRequest } from './fixtures/run-state';
import type { Page } from '@playwright/test';

/**
 * 承認プロセスの P0 例外・編集・共通系（A2/A6/A8/A9/A10）。
 *
 * 判定は「画面の表示」と「API の読み取り」の両方で行う。4xx は拒否・監査の実測値なので
 * 失敗にはしない（5xx と pageerror は roles.ts の自動フィクスチャが 0 件を強制する）。
 * 層②③（@otp / @prod-smoke）は本番・Staging を汚さないよう、作った依頼を finally で
 * 理由付きの取消にする（削除はしない）。
 */

interface ApiOutcome {
  status: number;
  body: any;
  text: string;
}

interface TransitionAttempt {
  result: ApiOutcome;
  before: ServerRequest;
}

/** 状態遷移をそのまま POST する（判定用。成功を前提にしない）。 */
async function postTransition(
  api: Api,
  id: string,
  to: Status,
  opts: { reason?: string; signal?: 'g' | 'y' | 'r'; version?: number } = {},
): Promise<TransitionAttempt> {
  const before = await serverRequest(api, id);
  const result = await api.post(`/api/requests/${encodeURIComponent(id)}/transitions`, {
    to,
    version: opts.version ?? before.version,
    reason: opts.reason ?? '',
    ...(opts.signal ? { signal: opts.signal } : {}),
    checklistAcknowledged: true,
    redAcknowledged: true,
  });
  return { result, before };
}

/** 承認者が受付 → 内容確認中 → 承認待ち へ進める（準備。判定は各テストの本題で行う）。 */
async function advanceToWait(api: Api, id: string): Promise<ServerRequest> {
  const review = await postTransition(api, id, 'review');
  expect(review.result.status, `内容確認中へ進めません: ${review.result.text.slice(0, 300)}`).toBe(200);
  const wait = await postTransition(api, id, 'wait');
  expect(wait.result.status, `承認待ちへ進めません: ${wait.result.text.slice(0, 300)}`).toBe(200);
  const detail = (wait.result.body as { detail: ServerRequest }).detail;
  expect(detail.status).toBe('wait');
  return detail;
}

/**
 * PATCH /api/requests/:id の本文を、いまの詳細の値から組み立てる（requestInputSchema の全項目）。
 * 内容を変える項目だけ overrides で差し替える。
 */
function requestInputFrom(detail: any, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: detail.title,
    kind: detail.kind,
    deptCode: detail.deptCode,
    applicant: detail.applicant,
    contact: detail.contact ?? null,
    toolId: detail.toolId ?? null,
    problem: detail.problem,
    purpose: detail.purpose,
    users: detail.users,
    people: detail.people ?? null,
    places: detail.places,
    scope: detail.scope,
    outOfScope: detail.outOfScope,
    criteria: detail.criteria,
    decides: detail.decides,
    dataHandling: detail.dataHandling,
    parties: detail.parties,
    constraints: detail.constraints,
    constraintsOther: detail.constraintsOther,
    approvals: detail.approvals,
    frequency: detail.frequency ?? null,
    minutesPerTime: detail.minutesPerTime ?? null,
    dataReady: detail.dataReady ?? null,
    spread: detail.spread ?? null,
    wishDate: detail.wishDate ?? null,
    approver: detail.approver,
    ...overrides,
  };
}

/**
 * 開いたままの状態変更ダイアログに理由を入れて送信する。
 * クライアント側で理由必須の抑止にかかったあと、同じダイアログから続行するために使う。
 */
async function submitOpenDialogWithReason(
  page: Page,
  api: Api,
  id: string,
  to: Status,
  reason: string,
): Promise<{ modalOpen: boolean; toast: string; status: Status; version: number }> {
  await page.fill('#modal #nnote', reason);
  await page.click('#modal [data-a="sok"]');
  await page.waitForTimeout(700);
  const modalOpen = (await page.locator('#modal.open').count()) > 0;
  const toast = await lastToast(page);
  const now = modalOpen ? await serverRequest(api, id) : await waitStatus(api, id, to);
  return { modalOpen, toast, status: now.status, version: now.version };
}

/** 依頼者と承認者の表示情報。作成に使う値だけで、実データ・実メールは扱わない。 */
async function twoAccounts(userApi: Api, adminApi: Api) {
  const requester = await currentUser(userApi);
  const approver = await currentUser(adminApi);
  return { requester, approver };
}

test(
  'A2 受付から承認待ちへの飛ばし遷移は 409 ERR-201 で拒否され、監査に denied で残る',
  { tag: ['@iso', '@otp'] },
  async ({ user, admin, evidence }) => {
    const { requester, approver } = await twoAccounts(user.api, admin.api);
    let id = '';
    try {
      const created = await createRequestViaApi(user.api, {
        title: uniqueTitle('A2 飛ばし'),
        decides: 'g',
        approverUserId: approver.id,
        approverName: approver.displayName,
        applicant: requester.displayName,
      });
      id = created.id;
      recordRequest(id, 'A2');
      expect(created.status, '作った依頼が受付ではない').toBe('received');
      expect(created.version).toBe(1);

      // 受付(received) → 承認待ち(wait) は遷移表に無い。承認者でも飛ばせない（409 ERR-201）。
      const { result, before } = await postTransition(admin.api, id, 'wait');
      expect(result.status, `飛ばし遷移が拒否されていない: ${result.text.slice(0, 300)}`).toBe(409);
      expect(result.body?.error?.code, `エラーコードが ERR-201 ではない: ${result.text.slice(0, 300)}`).toBe('ERR-201');

      const after = await serverRequest(admin.api, id);
      expect(after.status, '拒否されたのに状態が受付のままではない').toBe('received');
      expect(after.version, `拒否されたのに版が変わった（${before.version} → ${after.version}）`).toBe(before.version);

      // 拒否も監査に残る（request.transition_denied / result=denied）。
      const { items } = await auditLogs(admin.api, 500);
      const denied = items.filter((entry) => entry.targetId === id && entry.action === 'request.transition_denied');
      expect(denied.length, `拒否が監査に残っていない（${id}）`).toBeGreaterThan(0);
      expect(
        denied.some((entry) => entry.result === 'denied'),
        '拒否の監査が result=denied ではない',
      ).toBe(true);

      evidence.note('A2', {
        id,
        http: result.status,
        errorCode: result.body?.error?.code ?? null,
        errorMessage: result.body?.error?.message ?? null,
        status: after.status,
        version: after.version,
        auditDenied: denied.map((entry) => ({ action: entry.action, result: entry.result })),
      });
    } finally {
      if (!IS_ISO && id) {
        await cancelRequest(admin.api, id, '検証（A2）で作った作り物の依頼のため、確認後に取消').catch(() => undefined);
      }
    }
  },
);

test(
  'A6 一般利用者は承認できず（409 ERR-201）、画面でも「承認済み」を選べない',
  { tag: ['@iso', '@otp', '@prod-smoke'] },
  async ({ user, admin, evidence }) => {
    const { requester, approver } = await twoAccounts(user.api, admin.api);
    let id = '';
    try {
      const created = await createRequestViaApi(user.api, {
        title: uniqueTitle('A6 承認'),
        decides: 'g',
        approverUserId: approver.id,
        approverName: approver.displayName,
        applicant: requester.displayName,
      });
      id = created.id;
      recordRequest(id, 'A6');

      // 一般利用者（起票者）自身が API で承認しようとしても、役割の段階で 409 ERR-201。
      const { result, before } = await postTransition(user.api, id, 'approved', { signal: 'g' });
      expect(result.status, `一般利用者の承認が拒否されていない: ${result.text.slice(0, 300)}`).toBe(409);
      expect(result.body?.error?.code, `エラーコードが ERR-201 ではない: ${result.text.slice(0, 300)}`).toBe('ERR-201');

      const after = await serverRequest(user.api, id);
      expect(after.status, '拒否されたのに状態が受付のままではない').toBe('received');
      expect(after.version, `拒否されたのに版が変わった（${before.version} → ${after.version}）`).toBe(before.version);
      expect(after.signalDecided, '拒否されたのに信号の色が決まっている').toBeNull();

      // 画面: 一般利用者として依頼を開き、状態変更ダイアログの「承認済み」が disabled。
      await openApp(user.page);
      await openFromReview(user.page, id);
      await user.page.click(`#rin [data-a="status"][data-id="${id}"][title="状態を変更"]`);
      await user.page.waitForSelector('#modal.open');
      const approvedRadio = user.page.locator('#modal input[name="ns"][value="approved"]');
      await approvedRadio.waitFor();
      expect(await approvedRadio.isDisabled(), '画面では「承認済み」が選べてしまう').toBe(true);
      expect(await approvedRadio.isChecked(), '画面で「承認済み」が初期選択になっている').toBe(false);
      const enabledTargets = await user.page
        .locator('#modal input[name="ns"]')
        .evaluateAll((nodes) =>
          nodes.filter((node) => !(node as HTMLInputElement).disabled).map((node) => (node as HTMLInputElement).value),
        );
      expect(enabledTargets, '画面で「承認済み」を選べてしまう').not.toContain('approved');
      const dialogText = await user.page.locator('#modal').innerText();
      expect(dialogText, '「承認済み」は承認者だけ、という案内がダイアログに無い').toContain('承認者だけです');
      await closeModal(user.page);

      evidence.note('A6', {
        id,
        http: result.status,
        errorCode: result.body?.error?.code ?? null,
        status: after.status,
        version: after.version,
        signalDecided: after.signalDecided,
        uiApprovedDisabled: true,
        uiEnabledTargets: enabledTargets,
        uiHint: dialogText.slice(0, 300),
      });
    } finally {
      if (!IS_ISO && id) {
        await cancelRequest(admin.api, id, '検証（A6）で作った作り物の依頼のため、確認後に取消').catch(() => undefined);
      }
    }
  },
);

test(
  'A8 承認後の編集で承認待ちへ戻り（ERR-202）、再承認で order_version=2 になる',
  { tag: ['@iso', '@otp'] },
  async ({ user, admin, evidence }) => {
    const { requester, approver } = await twoAccounts(user.api, admin.api);
    let id = '';
    try {
      const created = await createRequestViaApi(user.api, {
        title: uniqueTitle('A8 再承認'),
        decides: 'g',
        approverUserId: approver.id,
        approverName: approver.displayName,
        applicant: requester.displayName,
      });
      id = created.id;
      recordRequest(id, 'A8');
      await advanceToWait(admin.api, id);

      // 1 回目の承認（API）: 決定色 g、注文書の版は 1。
      const approved = await postTransition(admin.api, id, 'approved', { signal: 'g' });
      expect(approved.result.status, `承認できません: ${approved.result.text.slice(0, 300)}`).toBe(200);
      const firstApproval = (approved.result.body as { detail: ServerRequest }).detail;
      expect(firstApproval.status).toBe('approved');
      expect(firstApproval.signalDecided).toBe('g');
      expect(firstApproval.orderVersion, `承認直後の order_version が 1 ではない（${firstApproval.orderVersion}）`).toBe(1);

      // 承認後に管理者が内容を変更する（requestInputSchema の全項目を既存値ベースで送る）。
      const current = await serverRequest(admin.api, id);
      const patched = await admin.api.patch(`/api/requests/${encodeURIComponent(id)}`, {
        ...requestInputFrom(current, { problem: '承認後に管理者が内容を追記した（E2E の作り物）' }),
        version: current.version,
      });
      expect(patched.status, `承認後の編集ができません: ${patched.text.slice(0, 300)}`).toBe(200);
      const warnings = (patched.body?.warnings ?? []) as { code: string; message: string }[];
      expect(
        warnings.map((warning) => warning.code),
        '承認後の編集に ERR-202 の警告が付いていない',
      ).toContain('ERR-202');
      const rewound = patched.body?.detail as ServerRequest & { problem: string };
      expect(rewound.status, '承認後の編集で承認待ちへ戻っていない').toBe('wait');
      expect(rewound.version, '編集で版が 1 つ進んでいない').toBe(current.version + 1);
      // 期待は「編集では order_version を動かさず、承認のたびに +1」（docs/development-line-handoff.md）。
      // 実装が違う場合は FAIL のまま残すが、後続の再承認・注文書タブの実測値も記録するため soft にする
      // （soft でもテストは失敗する）。
      expect
        .soft(rewound.orderVersion, `編集で order_version が動いている（${rewound.orderVersion}。承認待ちへ戻るだけのはず）`)
        .toBe(1);
      expect(rewound.signalDecided, '編集後も決定色が残っている（承認を取り消していない）').toBeNull();
      expect(rewound.problem, '変更した内容が保存されていない').toContain('承認後に管理者が内容を追記した');

      // 画面から再承認（signal g）。承認すると order_version が 2 になる（はず）。
      await openApp(admin.page);
      await openFromReview(admin.page, id);
      const reapproved = await approveViaUi(admin.page, admin.api, id, { signal: 'g' });
      expect(reapproved.done, `再承認できません: ${reapproved.toast}`).toBe(true);
      const finalRequest = await serverRequest(admin.api, id);
      expect(finalRequest.status).toBe('approved');
      expect.soft(finalRequest.orderVersion, `再承認後の order_version が 2 ではない（${finalRequest.orderVersion}）`).toBe(2);

      // 承認完了ダイアログの「注文書を見る」→ 注文書タブ（サーバの確定版）に order_version: 2（のはず）。
      await admin.page.click('#modal [data-a="lineYaml"]');
      await admin.page.waitForSelector('#rin pre.yaml', { timeout: 20_000 });
      const orderTab = admin.page.locator('#rin pre.yaml');
      await expect
        .poll(async () => /order_version:\s*\d+/.test(await orderTab.innerText()), {
          timeout: 20_000,
          message: '注文書タブに確定版（order_version）が出ない',
        })
        .toBe(true);
      const yaml = await orderTab.innerText();
      const orderTabVersion = /order_version:\s*(\d+)/.exec(yaml)?.[1] ?? null;
      const header = await admin.page.locator('#rin span.mono.hint', { hasText: 'order_version' }).innerText();
      expect.soft(orderTabVersion, `注文書タブの order_version が 2 ではない（${orderTabVersion}）`).toBe('2');
      expect.soft(header, `注文書タブの見出しが order_version: 2 ではない（${header}）`).toContain('order_version: 2');

      evidence.note('A8', {
        id,
        firstApproval: {
          status: firstApproval.status,
          version: firstApproval.version,
          signalDecided: firstApproval.signalDecided,
          orderVersion: firstApproval.orderVersion,
        },
        patch: {
          http: patched.status,
          warningCodes: warnings.map((warning) => warning.code),
          status: rewound.status,
          version: rewound.version,
          orderVersion: rewound.orderVersion,
          signalDecided: rewound.signalDecided,
        },
        reapproval: {
          status: finalRequest.status,
          version: finalRequest.version,
          orderVersion: finalRequest.orderVersion,
          toast: reapproved.toast,
        },
        orderTab: {
          header,
          orderVersion: orderTabVersion,
          hasOrderVersion2: yaml.includes('order_version: 2'),
        },
      });
    } finally {
      if (!IS_ISO && id) {
        await cancelRequest(admin.api, id, '検証（A8）で作った作り物の依頼のため、確認後に取消').catch(() => undefined);
      }
    }
  },
);

test(
  'A9 差戻しは理由必須で止まり、利用者が修正して再提出すると受付へ戻る',
  { tag: ['@iso', '@otp'] },
  async ({ user, admin, evidence }) => {
    const { requester, approver } = await twoAccounts(user.api, admin.api);
    let id = '';
    try {
      const created = await createRequestViaApi(user.api, {
        title: uniqueTitle('A9 差戻し'),
        decides: 'g',
        approverUserId: approver.id,
        approverName: approver.displayName,
        applicant: requester.displayName,
      });
      id = created.id;
      recordRequest(id, 'A9');
      await advanceToWait(admin.api, id);

      await openApp(admin.page);
      await openFromReview(admin.page, id);
      const waiting = await serverRequest(admin.api, id);

      // 理由が空のまま差戻し → 画面が送信前に止める（状態・版は不変、ダイアログは開いたまま）。
      const blocked = await submitStatus(admin.page, admin.api, id, 'back');
      expect(blocked.modalOpen, '理由が空なのにダイアログが閉じた（送信された可能性）').toBe(true);
      expect(blocked.toast, '理由必須のトーストが出ていない').toContain('理由をメモに書いてください');
      expect(blocked.status, '理由が空なのに状態が変わった').toBe('wait');
      expect(blocked.version, '理由が空なのに版が変わった').toBe(waiting.version);

      // 理由を入れて差戻し。
      const reason = '合格の条件が固まっていないため、数字で書き直してから再提出してください';
      const returned = await submitOpenDialogWithReason(admin.page, admin.api, id, 'back', reason);
      expect(returned.status, `差戻しできません: ${returned.toast}`).toBe('back');
      expect(returned.toast, '差戻しのトーストが違う').toContain('「差戻し」にしました');

      // 一般利用者が API で内容を修正する（起票者は back のあいだ編集できる）。
      const backDetail = await serverRequest(user.api, id);
      expect(backDetail.status).toBe('back');
      const patched = await user.api.patch(`/api/requests/${encodeURIComponent(id)}`, {
        ...requestInputFrom(backDetail, {
          problem: '差戻しの理由をうけて、困りごとを数字で書き直した（E2E の作り物）',
        }),
        version: backDetail.version,
      });
      expect(patched.status, `一般利用者が差戻し後に編集できません: ${patched.text.slice(0, 300)}`).toBe(200);
      expect(patched.body?.detail?.status, '編集で状態が動いた（差戻しのままのはず）').toBe('back');
      expect(patched.body?.detail?.problem, '修正した内容が保存されていない').toContain('数字で書き直した');

      // 一般利用者の画面の主ボタン「再提出する」で受付へ戻す。
      await openApp(user.page);
      await openFromReview(user.page, id);
      const mainButton = user.page.locator(`#rin [data-a="status"][data-id="${id}"][data-v="received"]`);
      await mainButton.waitFor({ timeout: 20_000 });
      expect(await mainButton.isDisabled(), '主ボタン「再提出する」が押せない').toBe(false);
      const mainLabel = (await mainButton.innerText()).trim();
      expect(mainLabel, '主ボタンが「再提出する」ではない').toContain('再提出する');

      const resubmitted = await submitStatus(user.page, user.api, id, 'received', { main: true });
      expect(resubmitted.ok, `再提出できません: ${resubmitted.toast}`).toBe(true);
      expect(resubmitted.status, '再提出後の状態が受付ではない').toBe('received');
      expect(resubmitted.toast, '再提出のトーストが違う').toContain('「受付」にしました');

      evidence.note('A9', {
        id,
        backBlocked: {
          toast: blocked.toast,
          modalOpen: blocked.modalOpen,
          status: blocked.status,
          version: blocked.version,
        },
        returned: { status: returned.status, version: returned.version, toast: returned.toast, reason },
        requesterPatch: {
          http: patched.status,
          status: patched.body?.detail?.status ?? null,
          version: patched.body?.detail?.version ?? null,
        },
        resubmitted: {
          status: resubmitted.status,
          version: resubmitted.version,
          toast: resubmitted.toast,
          mainLabel,
        },
      });
    } finally {
      if (!IS_ISO && id) {
        await cancelRequest(admin.api, id, '検証（A9）で作った作り物の依頼のため、確認後に取消').catch(() => undefined);
      }
    }
  },
);

test('A10 見送り・取消は理由必須で、依頼は削除されず履歴に残る', { tag: ['@iso', '@otp'] }, async ({ user, admin, evidence }) => {
  const { requester, approver } = await twoAccounts(user.api, admin.api);
  let holdId = '';
  let cancelId = '';
  try {
    // ---- 依頼1: 見送り（理由必須） ----
    const one = await createRequestViaApi(user.api, {
      title: uniqueTitle('A10 見送り'),
      decides: 'g',
      approverUserId: approver.id,
      approverName: approver.displayName,
      applicant: requester.displayName,
    });
    holdId = one.id;
    recordRequest(holdId, 'A10');
    await advanceToWait(admin.api, holdId);

    await openApp(admin.page);
    await openFromReview(admin.page, holdId);
    const beforeHold = await serverRequest(admin.api, holdId);
    const holdBlocked = await submitStatus(admin.page, admin.api, holdId, 'hold');
    expect(holdBlocked.modalOpen, '理由が空なのに見送りのダイアログが閉じた（送信された可能性）').toBe(true);
    expect(holdBlocked.toast, '見送りで理由必須のトーストが出ていない').toContain('理由をメモに書いてください');
    expect(holdBlocked.status, '理由が空なのに状態が変わった').toBe('wait');
    expect(holdBlocked.version, '理由が空なのに版が変わった').toBe(beforeHold.version);

    const held = await submitOpenDialogWithReason(admin.page, admin.api, holdId, 'hold', '今回は見送る（E2E の検証）');
    expect(held.status, `見送りできません: ${held.toast}`).toBe('hold');
    // 見送りは削除ではない。GET は 200 で deleted=false。
    const heldDetail = await serverRequest(admin.api, holdId);
    expect(heldDetail.status).toBe('hold');
    expect(heldDetail.deleted, '見送りで依頼が削除扱い（deleted=true）になっている').toBe(false);

    // ---- 依頼2: 取消（理由必須、行は残る） ----
    const two = await createRequestViaApi(user.api, {
      title: uniqueTitle('A10 取消'),
      decides: 'g',
      approverUserId: approver.id,
      approverName: approver.displayName,
      applicant: requester.displayName,
    });
    cancelId = two.id;
    recordRequest(cancelId, 'A10');
    await advanceToWait(admin.api, cancelId);

    // 依頼2 は画面を読み込んだ後に API で作ったため、一覧を取り直してから開く（F-4 の読み直し）。
    await openApp(admin.page);
    await openFromReview(admin.page, cancelId);
    const beforeCancel = await serverRequest(admin.api, cancelId);
    const cancelBlocked = await submitStatus(admin.page, admin.api, cancelId, 'cancel');
    expect(cancelBlocked.modalOpen, '理由が空なのに取消のダイアログが閉じた（送信された可能性）').toBe(true);
    expect(cancelBlocked.toast, '取消で理由必須のトーストが出ていない').toContain('理由をメモに書いてください');
    expect(cancelBlocked.status, '理由が空なのに状態が変わった').toBe('wait');
    expect(cancelBlocked.version, '理由が空なのに版が変わった').toBe(beforeCancel.version);

    const cancelled = await submitOpenDialogWithReason(admin.page, admin.api, cancelId, 'cancel', '取り下げる（E2E の検証）');
    expect(cancelled.status, `取消できません: ${cancelled.toast}`).toBe('cancel');

    // 取消は deleted=true だが行は残る。GET は 200、includeDeleted=1 の一覧に出る。
    const cancelledDetail = await serverRequest(admin.api, cancelId);
    expect(cancelledDetail.status).toBe('cancel');
    expect(cancelledDetail.deleted, '取消で deleted=true になっていない').toBe(true);

    const withDeleted = await admin.api.get(`/api/requests?includeDeleted=1&q=${encodeURIComponent(cancelId)}&pageSize=100`);
    expect(withDeleted.status).toBe(200);
    const shown = (withDeleted.body?.items ?? []) as { id: string; deleted?: boolean }[];
    expect(
      shown.map((item) => item.id),
      'includeDeleted=1 の一覧に取消した依頼が出ない（行が消えている）',
    ).toContain(cancelId);
    expect(shown.find((item) => item.id === cancelId)?.deleted, '一覧の取消依頼が deleted=true ではない').toBe(true);
    const defaultList = await admin.api.get(`/api/requests?q=${encodeURIComponent(cancelId)}&pageSize=100`);
    expect(defaultList.status).toBe(200);
    expect(
      ((defaultList.body?.items ?? []) as { id: string }[]).map((item) => item.id),
      '取消した依頼が既定の一覧に出ている（deleted の扱いが違う）',
    ).not.toContain(cancelId);

    // 監査: 見送り・取消の両方が遷移として残る。
    const { items } = await auditLogs(admin.api, 500);
    const audits: Record<string, { success: number; create: number }> = {};
    for (const [label, requestId] of [
      ['hold', holdId],
      ['cancel', cancelId],
    ] as const) {
      const forRequest = items.filter((entry) => entry.targetId === requestId);
      audits[label] = {
        success: forRequest.filter((entry) => entry.action === 'request.transition' && entry.result === 'success').length,
        create: forRequest.filter((entry) => entry.action === 'request.create').length,
      };
      expect(audits[label]!.success, `${label} の遷移が監査に残っていない（${requestId}）`).toBeGreaterThan(0);
      expect(audits[label]!.create, `${label} の受付が監査に残っていない（${requestId}）`).toBeGreaterThan(0);
    }

    evidence.note('A10', {
      hold: {
        id: holdId,
        blocked: { toast: holdBlocked.toast, modalOpen: holdBlocked.modalOpen, status: holdBlocked.status },
        result: { status: heldDetail.status, version: heldDetail.version, deleted: heldDetail.deleted },
        audit: audits.hold,
      },
      cancel: {
        id: cancelId,
        blocked: { toast: cancelBlocked.toast, modalOpen: cancelBlocked.modalOpen, status: cancelBlocked.status },
        result: { status: cancelledDetail.status, version: cancelledDetail.version, deleted: cancelledDetail.deleted },
        visibleWithIncludeDeleted: shown.some((item) => item.id === cancelId),
        visibleInDefaultList: ((defaultList.body?.items ?? []) as { id: string }[]).some((item) => item.id === cancelId),
        audit: audits.cancel,
      },
    });
  } finally {
    if (!IS_ISO) {
      for (const requestId of [holdId, cancelId]) {
        if (!requestId) continue;
        await cancelRequest(admin.api, requestId, '検証（A10）で作った作り物の依頼のため、確認後に取消').catch(() => undefined);
      }
    }
  }
});
