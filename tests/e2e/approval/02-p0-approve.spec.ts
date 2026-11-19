import type { Page } from '@playwright/test';
import { expect, test, IS_ISO, type Api } from './fixtures/roles';
import {
  advanceToWait,
  approveViaUi,
  auditLogs,
  cancelRequest,
  currentUser,
  openApp,
  openOrderFromSuccessModal,
  registerRequest,
  serverRequest,
  uniqueTitle,
  waitStatus,
  type ServerRequest,
  type Signal,
} from './fixtures/station';
import { recordRequest } from './fixtures/run-state';

/**
 * A3〜A7（P0 の承認系）: 承認待ちの依頼を画面から承認し、承認の規則（赤信号の確認・
 * 候補よりゆるい色の理由）と自己承認の拒否を実測する。
 * 対象: A3 は層①②③、A4/A5/A7 は層①②。
 *
 * 判定は「画面の表示」と「API で読み直した状態・版・信号・order_version」の両方で行う。
 * 期待と実装が違うときはテストを緩めず、実測値（トースト・状態・版）を evidence に残して FAIL にする。
 */

interface ApprovalAttempt {
  done: boolean;
  toast: string;
  modalOpen: boolean;
  status: ServerRequest['status'];
  version: number;
  signalDecided: string | null;
  orderVersion: number;
}

/**
 * これから出るトーストだけを記録する。画面のトーストは約 3.2 秒で DOM から消えるため、
 * 送信前に画面が止めた文言は「消えた後」でも読める必要がある（共有の approveViaUi は成功演出を
 * 12 秒待つので、そのままでは抑止のトーストを読み取れない）。
 */
async function captureToasts(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __e2eToasts: string[]; __e2eToastObserver?: MutationObserver };
    w.__e2eToasts = [];
    w.__e2eToastObserver?.disconnect();
    const box = document.querySelector('#toast');
    if (!box) return;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof HTMLElement) w.__e2eToasts.push((node.textContent ?? '').trim());
        }
      }
    });
    observer.observe(box, { childList: true });
    w.__e2eToastObserver = observer;
  });
  return async () => page.evaluate(() => (window as unknown as { __e2eToasts: string[] }).__e2eToasts ?? []);
}

/** 送信後の「承認完了（#rsdone）」か「トースト（クライアントの抑止・サーバ拒否）」のどちらかを待つ。 */
async function waitApprovalOutcome(
  page: Page,
  readToasts: () => Promise<string[]>,
  timeout = 15_000,
): Promise<{ done: boolean; toast: string }> {
  const deadline = Date.now() + timeout;
  let toasts: string[] = [];
  while (Date.now() < deadline) {
    const done = await page
      .locator('#modal #rsdone')
      .isVisible()
      .catch(() => false);
    toasts = await readToasts();
    if (done) return { done: true, toast: toasts.at(-1) ?? '' };
    if (toasts.length > 0) return { done: false, toast: toasts.at(-1) ?? '' };
    await page.waitForTimeout(120);
  }
  return { done: false, toast: toasts.at(-1) ?? '' };
}

/**
 * 承認ダイアログを開き、信号・赤の確認・メモを入れて「変更する」を押す。
 * 成功（承認済み）でも、送信前の抑止・サーバ拒否でも、同じ形で実測値を返す。
 */
async function attemptApproval(
  page: Page,
  api: Api,
  id: string,
  opts: { signal?: Signal; redAck?: boolean; reason?: string } = {},
): Promise<ApprovalAttempt> {
  const main = page.locator(`#rin [data-a="status"][data-id="${id}"][data-v="approved"]`);
  await main.waitFor({ timeout: 20_000 });
  expect(await main.isDisabled(), '承認ボタンが押せません（役割・状態の不一致）').toBe(false);
  await main.click();
  await page.waitForSelector('#modal.open');
  if (opts.signal) await page.check(`#modal input[name="fc"][value="${opts.signal}"]`);
  if (opts.redAck === true) await page.check('#modal #redok');
  if (opts.redAck === false) {
    const box = page.locator('#modal #redok');
    if (await box.isChecked()) await box.uncheck();
  }
  if (opts.reason !== undefined) await page.fill('#modal #nnote', opts.reason);
  const readToasts = await captureToasts(page);
  await page.click('#modal [data-a="sok"]');
  const outcome = await waitApprovalOutcome(page, readToasts);
  const now = outcome.done ? await waitStatus(api, id, 'approved') : await serverRequest(api, id);
  return {
    ...outcome,
    modalOpen: (await page.locator('#modal.open').count()) > 0,
    status: now.status,
    version: now.version,
    signalDecided: now.signalDecided,
    orderVersion: now.orderVersion,
  };
}

/** すでに開いている承認ダイアログ（送信前の抑止で開いたまま）から、条件を直して送信し直す。 */
async function submitOpenApproval(page: Page, api: Api, id: string): Promise<ServerRequest> {
  const readToasts = await captureToasts(page);
  await page.click('#modal [data-a="sok"]');
  const outcome = await waitApprovalOutcome(page, readToasts);
  expect(outcome.done, `承認できませんでした（トースト: ${outcome.toast}）`).toBe(true);
  return waitStatus(api, id, 'approved');
}

/** 承認完了ダイアログの「注文書を見る」から注文書タブを開き、サーバの確定版（order_version 入り）が表示されるまで待つ。 */
async function openServerOrder(page: Page, id: string): Promise<string> {
  await openOrderFromSuccessModal(page, id);
  const yaml = page.locator('#rin pre.yaml, #din pre.yaml').first();
  await expect
    .poll(async () => (await yaml.innerText()).trim(), {
      timeout: 20_000,
      message: '注文書タブにサーバの確定版（order_version）が表示されません',
    })
    .toMatch(/order_version:\s*1\b/);
  return (await yaml.innerText()).trim();
}

function approvingRequest(id: string): string {
  return `/api/requests/${encodeURIComponent(id)}`;
}

/**
 * A3: 一般利用者が画面で依頼を作成（候補=青）→ 管理者が画面で 受付→内容確認中→承認待ち → 青で承認。
 * 承認済み・signalDecided=g・orderVersion=1 を API で確認し、承認完了ダイアログの「注文書を見る」から
 * 注文書タブを開いて、YAML に order_version: 1・受付番号・件名・合格条件が含まれることを確認する。
 * GET /api/requests/:id/order でも order_version=1 を確認する。
 */
test(
  'A3 一般利用者の依頼を管理者が画面で承認すると、注文書に order_version=1 が出る',
  { tag: ['@iso', '@otp', '@prod-smoke'] },
  async ({ user, admin, evidence }) => {
    const requester = await currentUser(user.api);
    const approver = await currentUser(admin.api);
    const title = uniqueTitle('A3 承認');
    const criteria = ['検索結果が2秒以内に表示される', '同じ番号を二重に登録できない'];
    let id = '';

    try {
      const created = await registerRequest(user.page, { title, decides: 'g', criteria, approverUserId: approver.id });
      id = created.id;
      expect(id, '受付番号の形が違う').toMatch(/^REQ-\d{4}-\d{4}$/);
      recordRequest(id, 'A3');

      const received = await serverRequest(user.api, id);
      expect(received.title).toBe(title);
      expect(received.status).toBe('received');
      expect(received.applicantUserId, '起票者が一般利用者ではない').toBe(requester.id);
      expect(received.approverUserId, '承認者が管理者ではない').toBe(approver.id);

      // 管理者の画面を開き、画面から 受付 → 内容確認中 → 承認待ち へ進める。
      await openApp(admin.page);
      await advanceToWait(admin.page, admin.api, id);
      const before = await waitStatus(admin.api, id, 'wait');
      expect(before.signalDecided, '承認前に色が決まっている').toBeNull();
      expect(before.orderVersion, '承認前に注文書の版がある').toBe(0);

      const approved = await approveViaUi(admin.page, admin.api, id, { signal: 'g' });
      expect(approved.done, `承認できませんでした（トースト: ${approved.toast}）`).toBe(true);

      const after = await serverRequest(admin.api, id);
      expect(after.status, '承認済みになっていない').toBe('approved');
      expect(after.signalDecided, '決定した信号が青ではない').toBe('g');
      expect(after.orderVersion, '注文書の版が 1 ではない').toBe(1);
      expect(after.version, '承認で版が 1 つ進んでいない').toBe(before.version + 1);
      evidence.note('A3', {
        requestId: id,
        beforeApprove: {
          status: before.status,
          version: before.version,
          signalDecided: before.signalDecided,
          orderVersion: before.orderVersion,
        },
        afterApprove: {
          status: after.status,
          version: after.version,
          signalDecided: after.signalDecided,
          orderVersion: after.orderVersion,
        },
      });

      // 承認完了ダイアログの「注文書を見る」→ 注文書タブ。サーバの確定版が描画されるのを待つ。
      const yaml = await openServerOrder(admin.page, id);
      await expect(admin.page.locator('#rin .ptabs button.on')).toContainText('注文書');
      const uiChecks = {
        hasOrderVersion: /order_version:\s*1\b/.test(yaml),
        hasSchemaVersion: /schema_version:\s*"1\.0"/.test(yaml),
        hasRequestId: yaml.includes(`id: "${id}"`),
        hasTitle: yaml.includes(`title: "${title}"`),
        hasCriteria: criteria.every((criterion) => yaml.includes(criterion)),
        hasStatus: yaml.includes('status: "承認済み"'),
        yamlLines: yaml.split('\n').length,
      };
      evidence.note('A3', {
        requestId: id,
        uiYaml: uiChecks,
        afterApprove: {
          status: after.status,
          version: after.version,
          signalDecided: after.signalDecided,
          orderVersion: after.orderVersion,
        },
      });
      expect(uiChecks.hasOrderVersion, `画面の注文書 YAML に order_version: 1 が無い\n${yaml.slice(0, 600)}`).toBe(true);
      expect(uiChecks.hasRequestId, '画面の注文書 YAML に受付番号が無い').toBe(true);
      expect(uiChecks.hasTitle, '画面の注文書 YAML に件名が無い').toBe(true);
      expect(uiChecks.hasCriteria, '画面の注文書 YAML に合格条件が無い').toBe(true);

      const order = await admin.api.get(`${approvingRequest(id)}/order`);
      expect(order.status, `注文書 API が失敗: ${order.text.slice(0, 200)}`).toBe(200);
      const apiYaml = String(order.body.yaml ?? '');
      expect(order.body.version, '注文書 API の版が 1 ではない').toBe(1);
      expect(apiYaml).toMatch(/order_version:\s*1\b/);
      expect(apiYaml).toContain(`id: "${id}"`);
      evidence.note('A3', {
        requestId: id,
        apiOrder: { status: order.status, version: order.body.version, hasOrderVersion: /order_version:\s*1\b/.test(apiYaml) },
        uiYaml: uiChecks,
        afterApprove: {
          status: after.status,
          version: after.version,
          signalDecided: after.signalDecided,
          orderVersion: after.orderVersion,
        },
      });
    } finally {
      // 層②③は本番・Staging を汚さないよう、理由を付けて取消す（削除はしない）。
      if (!IS_ISO && id) {
        await cancelRequest(admin.api, id, '検証（A3）で作った作り物の依頼のため、確認後に取消').catch(() => undefined);
      }
    }
  },
);

/**
 * A4: 候補=赤。承認ダイアログで赤を選び、#redok をチェックせず送信すると、
 * クライアントのトースト「赤信号の確認にチェックしてください」で止まり、ダイアログは開いたまま・状態 wait・版不変。
 * その後 #redok をチェックして承認すると approved・signal=r になる。
 */
test(
  'A4 赤信号は確認チェックが無いと承認できず、チェックを入れると承認できる',
  { tag: ['@iso', '@otp'] },
  async ({ user, admin, evidence }) => {
    const approver = await currentUser(admin.api);
    const title = uniqueTitle('A4 赤信号');
    let id = '';

    try {
      const created = await registerRequest(user.page, { title, decides: 'r', approverUserId: approver.id });
      id = created.id;
      recordRequest(id, 'A4');

      await openApp(admin.page);
      await advanceToWait(admin.page, admin.api, id);
      const before = await waitStatus(admin.api, id, 'wait');
      expect(before.signalDecided).toBeNull();

      const blocked = await attemptApproval(admin.page, admin.api, id, { signal: 'r', redAck: false });
      evidence.note('A4', {
        requestId: id,
        blockedWithoutRedAck: blocked,
        beforeApprove: { status: before.status, version: before.version },
      });
      expect(blocked.done, '赤信号の確認チェック無しでも送信された（成功演出が出た）').toBe(false);
      expect(blocked.modalOpen, '赤信号の確認チェック無しでもダイアログが閉じた').toBe(true);
      expect(blocked.toast, '赤信号の確認を促すトーストが出ていない').toContain('赤信号の確認にチェックしてください');
      expect(blocked.status, '赤信号の確認チェック無しで状態が動いた').toBe('wait');
      expect(blocked.version, '赤信号の確認チェック無しで版が動いた').toBe(before.version);
      expect(blocked.signalDecided, '赤信号の確認チェック無しで色が決まった').toBeNull();

      // 開いたままのダイアログで #redok をチェックして承認する。
      await admin.page.check('#modal #redok');
      const approved = await submitOpenApproval(admin.page, admin.api, id);
      expect(approved.status).toBe('approved');
      expect(approved.signalDecided, '決定した信号が赤ではない').toBe('r');
      expect(approved.orderVersion, '注文書の版が 1 ではない').toBe(1);
      expect(approved.version, '承認で版が 1 つ進んでいない').toBe(before.version + 1);
      evidence.note('A4', {
        requestId: id,
        blockedWithoutRedAck: blocked,
        afterApprove: {
          status: approved.status,
          version: approved.version,
          signalDecided: approved.signalDecided,
          orderVersion: approved.orderVersion,
        },
      });
    } finally {
      if (!IS_ISO && id) {
        await cancelRequest(admin.api, id, '検証（A4）で作った作り物の依頼のため、確認後に取消').catch(() => undefined);
      }
    }
  },
);

/**
 * A5: 候補=黄。承認ダイアログで候補より緩い青を選び、メモ空で送信すると、
 * クライアントのトースト「候補よりゆるい色にする理由をメモに書いてください」で止まり、
 * ダイアログは開いたまま・状態 wait・版不変。理由を書いて送信すると approved・signal=g になる。
 */
test(
  'A5 候補よりゆるい色は理由が無いと送信前に止まり、理由を書くと承認できる',
  { tag: ['@iso', '@otp'] },
  async ({ user, admin, evidence }) => {
    const approver = await currentUser(admin.api);
    const title = uniqueTitle('A5 ゆるい色');
    const reason = '候補は黄だが、検索条件の解釈は人が確かめる必要があり、まず試作で確かめられる範囲に限るため青とした';
    let id = '';

    try {
      const created = await registerRequest(user.page, { title, decides: 'y', approverUserId: approver.id });
      id = created.id;
      recordRequest(id, 'A5');

      // 前提: 候補が黄（= 青は候補より緩い色）であること。
      const detail = await admin.api.get(approvingRequest(id));
      expect(detail.status, `依頼を取得できません: ${detail.text.slice(0, 200)}`).toBe(200);
      expect(detail.body.request.suggested?.color, '候補が黄ではない（A5 の前提が崩れている）').toBe('y');

      await openApp(admin.page);
      await advanceToWait(admin.page, admin.api, id);
      const before = await waitStatus(admin.api, id, 'wait');
      expect(before.signalDecided).toBeNull();

      const blocked = await attemptApproval(admin.page, admin.api, id, { signal: 'g' });
      evidence.note('A5', {
        requestId: id,
        candidate: detail.body.request.suggested,
        blockedWithoutReason: blocked,
        beforeApprove: { status: before.status, version: before.version },
      });
      expect(blocked.done, '候補よりゆるい色を理由なしで送信できてしまった').toBe(false);
      expect(blocked.modalOpen, '理由が無いのにダイアログが閉じた').toBe(true);
      expect(blocked.toast, '候補よりゆるい色の理由を促すトーストが出ていない').toContain(
        '候補よりゆるい色にする理由をメモに書いてください',
      );
      expect(blocked.status, '理由が無いのに状態が動いた').toBe('wait');
      expect(blocked.version, '理由が無いのに版が動いた').toBe(before.version);
      expect(blocked.signalDecided, '理由が無いのに色が決まった').toBeNull();

      // 開いたままのダイアログで理由を書いて承認する。
      await admin.page.fill('#modal #nnote', reason);
      const approved = await submitOpenApproval(admin.page, admin.api, id);
      expect(approved.status).toBe('approved');
      expect(approved.signalDecided, '決定した信号が青ではない').toBe('g');
      expect(approved.orderVersion, '注文書の版が 1 ではない').toBe(1);
      expect(approved.version, '承認で版が 1 つ進んでいない').toBe(before.version + 1);

      // 理由が履歴（承認の記録）に残っていること。
      const afterDetail = await admin.api.get(approvingRequest(id));
      const history = (afterDetail.body.request.history ?? []) as { action?: string; note?: string }[];
      const reasonInHistory = history.some((entry) => String(entry.note ?? '').includes(reason));
      evidence.note('A5', {
        requestId: id,
        candidate: detail.body.request.suggested,
        blockedWithoutReason: blocked,
        afterApprove: {
          status: approved.status,
          version: approved.version,
          signalDecided: approved.signalDecided,
          orderVersion: approved.orderVersion,
          reason,
        },
        reasonInHistory,
      });
      expect(reasonInHistory, '承認の理由が履歴に残っていない').toBe(true);
    } finally {
      if (!IS_ISO && id) {
        await cancelRequest(admin.api, id, '検証（A5）で作った作り物の依頼のため、確認後に取消').catch(() => undefined);
      }
    }
  },
);

/**
 * A7: 管理者自身が画面で依頼を作成（承認者=自分）→ 自分で 受付 → 内容確認中 → 承認待ち。
 * 自分で承認しようとすると赤トースト「自分で自分を承認することはできません」で拒否され、
 * 状態 wait・版不変・監査に approval.self_denied（result=denied）が残る。
 */
test(
  'A7 管理者が自分の依頼を自分で承認しようとすると拒否され、状態と版が変わらない',
  { tag: ['@iso', '@otp'] },
  async ({ admin, evidence, recorder }) => {
    const me = await currentUser(admin.api);
    const title = uniqueTitle('A7 自己承認');
    let id = '';

    try {
      // 管理者自身が画面から依頼を作成し、承認者に自分を選ぶ。
      const created = await registerRequest(admin.page, { title, decides: 'g', approverUserId: me.id });
      id = created.id;
      recordRequest(id, 'A7');
      const received = await serverRequest(admin.api, id);
      expect(received.applicantUserId, '起票者が管理者自身ではない').toBe(me.id);
      expect(received.approverUserId, '承認者が管理者自身ではない').toBe(me.id);

      await advanceToWait(admin.page, admin.api, id);
      const before = await waitStatus(admin.api, id, 'wait');
      expect(before.signalDecided).toBeNull();

      const denied = await attemptApproval(admin.page, admin.api, id, { signal: 'g' });
      const { items } = await auditLogs(admin.api);
      const selfDeniedAll = items.filter((entry) => entry.action === 'approval.self_denied' && entry.targetId === id);
      const selfDenied = selfDeniedAll[0];
      // F-3: 403 の取り直しは CSRF が切り替わったときだけ。権限拒否で送り直すと、
      // 拒否要求と監査が 1 操作で二重になる（画面の 403 を数えて固定する）。
      const transitionDenials = recorder.http.filter(
        (entry) => entry.status === 403 && entry.method === 'POST' && new URL(entry.url).pathname.endsWith('/transitions'),
      );
      evidence.note('A7', {
        requestId: id,
        selfApprovalAttempt: denied,
        beforeApprove: { status: before.status, version: before.version },
        transitionDenials,
        audit: selfDenied ? { action: selfDenied.action, result: selfDenied.result, targetId: selfDenied.targetId } : null,
        selfDeniedCount: selfDeniedAll.length,
      });
      expect(denied.done, '自己承認が通ってしまった（成功演出が出た）').toBe(false);
      expect(denied.modalOpen, '自己承認の拒否でダイアログが閉じた').toBe(true);
      expect(denied.toast, '自己承認を拒否する赤トーストが出ていない').toContain('自分で自分を承認することはできません');
      expect(denied.status, '自己承認の拒否で状態が動いた').toBe('wait');
      expect(denied.version, '自己承認の拒否で版が動いた').toBe(before.version);
      expect(denied.signalDecided, '自己承認の拒否で色が決まった').toBeNull();
      expect(selfDenied, '自己承認の拒否が監査（approval.self_denied）に残っていない').toBeTruthy();
      expect(selfDenied?.result, '自己承認の拒否の監査結果が denied ではない').toBe('denied');
      expect(transitionDenials, '403 の再送で拒否要求が二重になっている（F-3）').toHaveLength(1);
      expect(selfDeniedAll, '自己承認の拒否の監査が二重に残っている（F-3）').toHaveLength(1);
    } finally {
      if (!IS_ISO && id) {
        await cancelRequest(admin.api, id, '検証（A7）で作った作り物の依頼のため、確認後に取消').catch(() => undefined);
      }
    }
  },
);
