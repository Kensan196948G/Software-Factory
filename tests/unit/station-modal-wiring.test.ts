import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { STATUSES, isReasonRequired, isTransitionDefined } from '@shared/domain.js';

// ステーション画面（src/web/public/station.js）のダイアログの決まりを固定する。
// 画面の動きは tests/e2e/station-modal.spec.ts が確かめる。ここは、画面の関数を取り出して
// 動かし、サーバの決まり（src/shared/domain.ts）と食い違っていないかだけを見る。
const js = readFileSync('src/web/public/station.js', 'utf8');

/** station.js から 1 行で書かれた関数の定義を取り出す。 */
function lineOf(name: string): string {
  const line = js.split('\n').find((l) => l.startsWith(`function ${name}(`));
  if (!line) throw new Error(`station.js に function ${name} がありません`);
  return line;
}

it('理由が必須の状態変更を、画面がサーバと同じかそれ以上に止める', () => {
  const needReason = new Function(`${lineOf('needReason')};return needReason;`)() as (from: string, to: string) => boolean;
  const missed: string[] = [];
  let required = 0;
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (!isTransitionDefined(from, to) || !isReasonRequired(from, to)) continue;
      required += 1;
      if (!needReason(from, to)) missed.push(`${from} → ${to}`);
    }
  }
  expect(required).toBeGreaterThan(0);
  // サーバが理由を求める遷移を、画面が理由なしで送ってしまう組が無い（取消を含む）
  expect(missed).toEqual([]);
  expect(needReason('received', 'cancel')).toBe(true);
  expect(needReason('field', 'dev')).toBe(true);
  expect(needReason('release_wait', 'dev')).toBe(true);
  // 理由が要らない遷移まで止めない
  expect(needReason('received', 'review')).toBe(false);
  expect(needReason('verify', 'dev')).toBe(false);
  expect(needReason('wait', 'approved')).toBe(false);
  // 状態変更の送信前チェックがこの判定を通る
  expect(js).toContain("if(needReason(r.status,v)&&!note){toast('理由をメモに書いてください','bad');return}");
});

it('ダイアログを閉じると中身を消す（入力したパスワードを DOM に残さない）', () => {
  const classes = new Set(['modal', 'open']);
  const modalEl = {
    innerHTML: '<div class="card"><input id="uPass" type="password"></div>',
    classList: { remove: (name: string) => classes.delete(name) },
  };
  const busy: boolean[] = [];
  const run = new Function(
    '$',
    'setBusy',
    `let modalHook=1,confirmFn=1;${lineOf('closeModal')};closeModal();return [modalHook,confirmFn];`,
  );
  const state = run(
    (selector: string) => {
      expect(selector).toBe('#modal');
      return modalEl;
    },
    (value: boolean) => busy.push(value),
  );
  expect(modalEl.innerHTML).toBe('');
  expect(classes.has('open')).toBe(false);
  expect(state).toEqual([null, null]);
  expect(busy).toEqual([false]);
});
