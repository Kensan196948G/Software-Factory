import { describe, expect, it } from 'vitest';
import {
  APPROVALS,
  DATA_HANDLING,
  checkCriteria,
  computeMeasure,
  computeScore,
  evaluateSignal,
  isReasonRequired,
  isTransitionDefined,
  preApprovalChecklist,
  rewriteGroupsFor,
  roleCanTransition,
  staleDays,
  staleLevel,
  transitionOptions,
  validateApproval,
  yourTurn,
} from '@shared/domain.js';
import type { Role } from '@shared/domain.js';

const actor = (role: Role, userId = 'u1') => ({ role, userId, displayName: 'テスト' });
const request = (applicantUserId: string | null = 'u1', approverUserId: string | null = null) => ({
  requestId: 'REQ-2026-0001',
  applicantUserId,
  approverUserId,
  approverName: '鈴木 一郎',
});

describe('信号の色の判定（R1〜R6）', () => {
  it('何も選ばれていなければ青で、判定材料がない理由を返す', () => {
    const v = evaluateSignal({ decides: null });
    expect(v.color).toBe('g');
    expect(v.reasons.join()).toContain('まだ判定材料がありません');
  });

  it('R1: 「決める」を選ぶと赤', () => {
    expect(evaluateSignal({ decides: 'r' }).color).toBe('r');
    expect(evaluateSignal({ decides: 'y' }).color).toBe('y');
    expect(evaluateSignal({ decides: 'g' }).color).toBe('g');
  });

  it('R2: カタログの色が青以外なら引き上げる（赤は赤のまま）', () => {
    expect(evaluateSignal({ decides: 'g', catalogSignal: 'y' }).color).toBe('y');
    expect(evaluateSignal({ decides: 'g', catalogSignal: 'r' }).color).toBe('r');
  });

  it('R3: 扱う情報は最大でも黄まで', () => {
    const v = evaluateSignal({ decides: 'g', dataHandling: DATA_HANDLING.map((d) => d.key) });
    expect(v.color).toBe('y');
    expect(v.reasons.some((r) => r.includes('工事写真'))).toBe(true);
  });

  it('R4: 社外が関わると黄', () => {
    expect(evaluateSignal({ decides: 'g', parties: 'partner' }).color).toBe('y');
    expect(evaluateSignal({ decides: 'g', parties: 'client' }).color).toBe('y');
  });

  it('R5/R6: 安全・作業船は黄（赤にはしない）', () => {
    expect(evaluateSignal({ decides: 'g', approvals: [APPROVALS[5]] }).color).toBe('y');
    expect(evaluateSignal({ decides: 'g', approvals: [APPROVALS[6]] }).color).toBe('y');
  });

  it('R1が赤ならR3〜R6で下がらない', () => {
    expect(evaluateSignal({ decides: 'r', parties: 'client', dataHandling: ['money'] }).color).toBe('r');
  });
});

describe('合格の条件の書き方チェック', () => {
  it('空は empty（助言なし）', () => {
    expect(checkCriteria('   ').kind).toBe('empty');
  });
  it('仮置き記号は placeholder', () => {
    expect(checkCriteria('〇〇が3秒以内に表示される').kind).toBe('placeholder');
    expect(checkCriteria('△△は□□以内').kind).toBe('placeholder');
  });
  it('あいまい語は vague で、長い語から順に返す', () => {
    const r = checkCriteria('使いやすい画面でわかりやすい表示にする');
    expect(r.kind).toBe('vague');
    expect(r.vagueWords[0]).toBe('わかりやすい');
    expect(r.vagueWords).toContain('使いやすい');
  });
  it('8文字未満は short', () => {
    expect(checkCriteria('はやい').kind).toBe('short');
  });
  it('具体的なら ok', () => {
    expect(checkCriteria('空欄が1件でもあれば提出できない').kind).toBe('ok');
  });
  it('書き換え候補のグループが返る', () => {
    expect(rewriteGroupsFor('使いやすい').map((g) => g.id)).toContain(1);
    expect(rewriteGroupsFor('早く終わる').map((g) => g.id)).toContain(3);
  });
});

describe('ものさしと点数の計算', () => {
  it('人数×頻度係数×手間÷60（小数1桁）', () => {
    expect(computeMeasure({ people: 40, frequency: 'd', minutesPerTime: 15 })).toBe(200);
    expect(computeMeasure({ people: 50, frequency: 'd', minutesPerTime: 20 })).toBe(333.3);
    expect(computeMeasure({ people: 1, frequency: 'o', minutesPerTime: 1 })).toBe(0);
  });
  it('空・負・未選択は0', () => {
    expect(computeMeasure({ people: null, frequency: 'd', minutesPerTime: 10 })).toBe(0);
    expect(computeMeasure({ people: 10, frequency: null, minutesPerTime: 10 })).toBe(0);
    expect(computeMeasure({ people: -1, frequency: 'd', minutesPerTime: 10 })).toBe(0);
  });
  it('5観点は0〜5で、合計は出さない', () => {
    const rows = computeScore({ people: 120, signal: 'g', frequency: 'd', minutesPerTime: 60, dataReady: 5, spread: 5 });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.score >= 0 && r.score <= 5)).toBe(true);
    expect(rows.find((r) => r.key === 'signal')?.score).toBe(5);
    expect(computeScore({ people: 0, signal: undefined }).find((r) => r.key === 'signal')?.score).toBe(0);
  });
});

describe('状態遷移（本番の遷移表）', () => {
  it('定義された遷移だけ許可する', () => {
    expect(isTransitionDefined('received', 'review')).toBe(true);
    expect(isTransitionDefined('received', 'approved')).toBe(false);
    expect(isTransitionDefined('done', 'dev')).toBe(false);
    expect(isTransitionDefined('wait', 'approved')).toBe(true);
    expect(isTransitionDefined('release_wait', 'done')).toBe(true);
  });

  it('依頼者は自分の依頼の再提出と取り下げだけ', () => {
    const a = actor('requester');
    expect(roleCanTransition('back', 'received', a, request('u1'), true).allowed).toBe(true);
    expect(roleCanTransition('received', 'hold', a, request('u1'), true).allowed).toBe(true);
    expect(roleCanTransition('received', 'review', a, request('u1'), true).allowed).toBe(false);
    expect(roleCanTransition('received', 'review', a, request('u2'), false).allowed).toBe(false);
  });

  it('受付担当は承認・完了へ進めない', () => {
    const a = actor('desk');
    expect(roleCanTransition('wait', 'approved', a, request('u1'), false).allowed).toBe(false);
    expect(roleCanTransition('release_wait', 'done', a, request('u1'), false).allowed).toBe(false);
    expect(roleCanTransition('received', 'review', a, request('u1'), false).allowed).toBe(true);
  });

  it('承認者は全遷移できるが、担当外の承認はできない', () => {
    const approver = actor('approver', 'a1');
    expect(roleCanTransition('wait', 'approved', approver, request('u1', 'a1'), false).allowed).toBe(true);
    expect(roleCanTransition('wait', 'approved', approver, request('u1', 'a2'), false).allowed).toBe(false);
    expect(roleCanTransition('wait', 'approved', approver, request('u1', null), false).allowed).toBe(true);
  });

  it('差戻し・見送り・取消は理由必須', () => {
    expect(isReasonRequired('wait', 'back')).toBe(true);
    expect(isReasonRequired('wait', 'hold')).toBe(true);
    expect(isReasonRequired('received', 'cancel')).toBe(true);
    expect(isReasonRequired('received', 'review')).toBe(false);
  });

  it('選べない状態には理由とできる人を返す', () => {
    const options = transitionOptions('wait', actor('desk'), request('u1'), false);
    const approved = options.find((o) => o.to === 'approved');
    expect(approved?.allowed).toBe(false);
    expect(approved?.who).toBe('approver');
    expect(approved?.reason).toContain('承認者');
  });

  it('完了した依頼は承認者以外動かせない', () => {
    const verdict = roleCanTransition('done', 'dev', actor('desk'), request('u1'), true);
    expect(verdict.allowed).toBe(false);
  });
});

describe('承認前チェックと承認の検証', () => {
  const base = {
    criteria: ['空欄が1件でもあれば提出できない'],
    outOfScope: ['安全の合否判定'],
    dataHandling: [],
    parties: 'internal',
    approvals: [],
    decides: 'g',
    suggested: 'g' as const,
  };

  it('問題がなければ△なし', () => {
    const items = preApprovalChecklist(base);
    expect(items.filter((i) => i.visible && i.status === 'warn')).toHaveLength(0);
  });

  it('あいまいな条件・今回は作らない空・扱う情報は△', () => {
    const items = preApprovalChecklist({
      ...base,
      criteria: ['使いやすい'],
      outOfScope: [],
      dataHandling: ['personal'],
    });
    const keys = items.filter((i) => i.status === 'warn').map((i) => i.key);
    expect(keys).toContain('crit');
    expect(keys).toContain('out');
    expect(keys).toContain('data');
  });

  it('△があるときは確認チェックが必要', () => {
    const r = validateApproval({
      ...base,
      criteria: ['使いやすい'],
      decided: 'g',
      checklistAcknowledged: false,
      redAcknowledged: false,
      reason: '',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('承認前チェック');
  });

  it('赤は赤の確認が必要', () => {
    const r = validateApproval({
      ...base,
      criteria: ['使いやすい'],
      decides: 'r',
      suggested: 'r',
      decided: 'r',
      checklistAcknowledged: true,
      redAcknowledged: false,
      reason: '',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('赤信号');
  });

  it('候補よりゆるい色は理由が必要', () => {
    const r = validateApproval({
      ...base,
      suggested: 'y',
      decided: 'g',
      checklistAcknowledged: true,
      redAcknowledged: false,
      reason: '',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('ゆるい色');
    const ok = validateApproval({
      ...base,
      suggested: 'y',
      decided: 'g',
      checklistAcknowledged: true,
      redAcknowledged: false,
      reason: '表示だけのため',
    });
    expect(ok.ok).toBe(true);
  });
});

describe('あなたの番・滞留', () => {
  it('受付担当は受付〜現場試用が自分の番', () => {
    expect(yourTurn('received', actor('desk'), {}).target).toBe(true);
    expect(yourTurn('wait', actor('desk'), {}).target).toBe(false);
    expect(yourTurn('release_wait', actor('desk'), {}).target).toBe(false);
  });
  it('承認者は承認待ち・公開承認待ちが自分の番（担当分のみ）', () => {
    expect(yourTurn('wait', actor('approver', 'a1'), { approverUserId: 'a1' }).target).toBe(true);
    expect(yourTurn('wait', actor('approver', 'a1'), { approverUserId: 'a2' }).target).toBe(false);
    expect(yourTurn('release_wait', actor('approver', 'a1'), {}).target).toBe(true);
  });
  it('依頼者は差戻しの自分の依頼が自分の番', () => {
    expect(yourTurn('back', actor('requester', 'u1'), { applicantUserId: 'u1' }).target).toBe(true);
    expect(yourTurn('back', actor('requester', 'u1'), { applicantUserId: 'u2' }).target).toBe(false);
  });
  it('滞留日数は切り捨て、しきい値で段階が変わる', () => {
    const now = new Date('2026-10-28T00:00:00Z');
    expect(staleDays('2026-10-27T23:00:00Z', now)).toBe(0);
    expect(staleDays('2026-10-25T00:00:00Z', now)).toBe(3);
    expect(staleLevel(2)).toBe('ok');
    expect(staleLevel(3)).toBe('warn');
    expect(staleLevel(7)).toBe('danger');
  });
});
