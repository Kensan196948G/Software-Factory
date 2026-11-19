import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { STATUSES, isReasonRequired, isTransitionDefined } from '@shared/domain.js';
import type { Status } from '@shared/domain.js';

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

it('理由が必須の状態変更の判定が、全組でサーバの決まりと一致する（画面だけの必須は差戻し・見送りに限る）', () => {
  const needReason = new Function(`${lineOf('needReason')};return needReason;`)() as (from: string, to: string) => boolean;
  // 画面だけが理由を求める組。修正前から、画面は差戻し・見送りを変更前の状態に関係なく必須にしている。
  // サーバに定義のある遷移では「承認待ち以外からの見送り」だけがこれに当たる（差戻しは定義のある組すべてがサーバでも必須）。
  // 定義の無い遷移（サーバが ERR-201 で拒否する）では、差戻し・見送りへの変更がこれに当たる。
  const screenOnly = (from: Status, to: Status): boolean =>
    isTransitionDefined(from, to) ? to === 'hold' && from !== 'wait' : to === 'back' || to === 'hold';

  const missed: string[] = []; // サーバは必須なのに、画面が理由なしで送ってしまう
  const excess: string[] = []; // サーバも上の例外も求めないのに、画面が止めてしまう
  const screenOnlyDefined: string[] = [];
  let pairs = 0;
  let required = 0;
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      pairs += 1;
      const server = isReasonRequired(from, to);
      const actual = needReason(from, to);
      if (server) required += 1;
      if (server && !actual) missed.push(`${from} → ${to}`);
      if (actual !== (server || screenOnly(from, to))) excess.push(`${from} → ${to}: 画面=${actual} サーバ=${server}`);
      if (isTransitionDefined(from, to) && actual && !server) screenOnlyDefined.push(`${from} → ${to}`);
    }
  }
  expect(pairs).toBe(STATUSES.length * STATUSES.length);
  expect(required).toBeGreaterThan(0);
  expect(missed).toEqual([]);
  expect(excess).toEqual([]);
  // 定義のある遷移で画面のほうが厳しいのは、この 3 組だけ（増えても減っても気づけるようにする）
  expect(screenOnlyDefined).toEqual(['received → hold', 'review → hold', 'back → hold']);

  expect(needReason('received', 'cancel')).toBe(true);
  expect(needReason('field', 'dev')).toBe(true);
  expect(needReason('release_wait', 'dev')).toBe(true);
  expect(needReason('received', 'review')).toBe(false);
  expect(needReason('verify', 'dev')).toBe(false);
  expect(needReason('approved', 'dev')).toBe(false);
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
