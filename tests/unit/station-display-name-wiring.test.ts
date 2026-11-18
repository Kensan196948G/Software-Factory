import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ステーション画面（src/web/public/station.js）の表示名の決まりを固定する（2026-11-18）。
//
// アカウントの表示名は DB の app_user.display_name を正とする。サーバは起動データ
// （window.__MSF__.user）に displayName と roles を入れる。画面が名簿（window.__SF_ACTORS__）の
// 代表者名を表示名に使っていたため、ログインした本人ではなく名簿の代表者名が出ていた（不具合 F-6）。
// また「操作する人」の選択肢に、その利用者が持っていない役割まで出ていた（不具合 F-2）。
//
// ここでは画面の関数を取り出して動かし、表示名と選択肢の決まりだけを見る。
// 実際のログイン・画面表示は tests/e2e/station-display-name.spec.ts が実サーバ・実 DB で確かめる。
const js = readFileSync('src/web/public/station.js', 'utf8');

/**
 * station.js の `const NAME=...` の定義を 1 文ぶん取り出す。
 * 画面の関数は `()=>{ ... };` の形なので、最初の `{` から対応する `}` までを数え、
 * その直後の `;` までを含める（文字列の中に `{` や `}` を含む定義は無い前提）。
 */
function defOf(name: string): string {
  const start = js.indexOf(`const ${name}=`);
  if (start < 0) throw new Error(`station.js に const ${name} の定義がありません`);
  const open = js.indexOf('{', start);
  if (open < 0) throw new Error(`const ${name} の定義に本体がありません`);
  let depth = 0;
  for (let i = open; i < js.length; i += 1) {
    if (js[i] === '{') depth += 1;
    else if (js[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const semi = js.indexOf(';', i);
        if (semi < 0) throw new Error(`const ${name} の定義が終わりません`);
        return js.slice(start, semi + 1);
      }
    }
  }
  throw new Error(`const ${name} の定義が終わりません`);
}

/** station.js の `function NAME(` / `async function NAME(` の定義を 1 文ぶん取り出す。 */
function fnDefOf(name: string): string {
  for (const head of [`async function ${name}(`, `function ${name}(`]) {
    const start = js.indexOf(head);
    if (start < 0) continue;
    const open = js.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < js.length; i += 1) {
      if (js[i] === '{') depth += 1;
      else if (js[i] === '}') {
        depth -= 1;
        if (depth === 0) return js.slice(start, i + 1);
      }
    }
  }
  throw new Error(`station.js に function ${name} の定義がありません`);
}

/** station.js と同じ並び・名前の役割（画面の ROLES と一致することは既存の E2E が見ている）。 */
const ROLES = [
  { k: 'requester', l: '依頼者', name: '山田 太郎', dept: 'koji' },
  { k: 'desk', l: '受付担当（IT・DX）', name: '佐藤 花子', dept: 'it' },
  { k: 'approver', l: '承認者（業務責任者）', name: '鈴木 一郎', dept: 'koji' },
];
const roleOf = (key: string) => ROLES.find((r) => r.k === key) ?? ROLES[0];
const E = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Role = 'requester' | 'desk' | 'approver';
interface RosterActor {
  name: string;
  divisionCode: string;
  divisionName: string;
  section: string;
}
interface FakeWindow {
  __MSF__?: { user: { displayName: string; deptCode?: string; roles?: string[] } };
  __SF_ACTORS__?: Record<Role, RosterActor>;
}
type Scope = {
  window: FakeWindow;
  ROLES: typeof ROLES;
  roleOf: typeof roleOf;
  E: typeof E;
  S: { role: Role };
  heldRoles?: unknown;
};

const ACTORS: Record<Role, RosterActor> = {
  requester: { name: '山田 敏久', divisionCode: 'tokyo', divisionName: '東京支店', section: '工事部' },
  desk: { name: '石原 慎太郎', divisionCode: 'kanri', divisionName: '管理本部', section: 'DX推進部' },
  approver: { name: '鈴木 一郎', divisionCode: 'gijutsu', divisionName: '技術本部', section: '技術部' },
};

/** station.js の定義を、画面と同じ名前の値を渡して評価し、関数（または値）を取り出す。 */
function evaluate<T>(name: string, scope: Scope, deps: string[] = ['window', 'ROLES', 'roleOf', 'E', 'S']): T {
  const values = deps.map((dep) => (scope as unknown as Record<string, unknown>)[dep]);
  return new Function(...deps, `${defOf(name)}\nreturn ${name};`)(...values) as T;
}

/** ログイン中の利用者（サーバ）と名簿の両方がある状態の画面を作る。 */
function screenWith(user: NonNullable<FakeWindow['__MSF__']>['user'], role: Role = 'requester') {
  const win: FakeWindow = { __MSF__: { user }, __SF_ACTORS__: ACTORS };
  const scope: Scope = { window: win, ROLES, roleOf, E, S: { role } };
  scope.heldRoles = evaluate('heldRoles', scope, ['window', 'ROLES']);
  const me = evaluate<(r: Role) => { name: string; dept: string }>('me', scope);
  const roleOpts = evaluate<string>('ROLE_OPTS', scope, ['window', 'ROLES', 'E', 'heldRoles']);
  const held = evaluate<() => Role[] | null>('heldRoles', scope, ['window', 'ROLES']);
  return {
    name: (r: Role) => me(r).name,
    dept: (r: Role) => me(r).dept,
    held: held(),
    roleOpts,
    optionValues: [...roleOpts.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]),
    optionLabels: [...roleOpts.matchAll(/<option value="[^"]+">([^<]*)<\/option>/g)].map((m) => m[1]),
  };
}

it('me() はログイン中の利用者の表示名（__MSF__.user.displayName）を優先し、名簿の代表者名を使わない', () => {
  const s = screenWith({ displayName: '管理者', deptCode: 'dx', roles: ['approver'] }, 'approver');
  expect(s.name('approver')).toBe('管理者');
  expect(s.name('requester')).toBe('管理者');
  expect(s.name('desk')).toBe('管理者');
  // 名簿の代表者名（山田 敏久・石原 慎太郎・鈴木 一郎）にならない
  for (const role of ['requester', 'desk', 'approver'] as Role[]) {
    expect(s.name(role)).not.toBe(ACTORS[role].name);
    expect(['山田 敏久', '石原 慎太郎', '鈴木 一郎']).not.toContain(s.name(role));
  }
  // 部署は利用者の所属（deptCode）を使う
  expect(s.dept('approver')).toBe('dx');
});

it('サーバ非接続（見本）のときだけ、従来どおり名簿の見本名を使う', () => {
  const win: FakeWindow = { __SF_ACTORS__: ACTORS };
  const scope: Scope = { window: win, ROLES, roleOf, E, S: { role: 'approver' } };
  scope.heldRoles = evaluate('heldRoles', scope, ['window', 'ROLES']);
  const me = evaluate<(r: Role) => { name: string }>('me', scope);
  expect(me('approver').name).toBe('鈴木 一郎');
  expect((scope.heldRoles as () => unknown)()).toBeNull();
});

it('ROLE_OPTS はログイン中の利用者が持つ役割だけを出し、ラベルは「表示名（役割名）」にする', () => {
  // 承認者の役割だけを持つ利用者: 依頼者・受付担当は出ない
  const approver = screenWith({ displayName: '管理者', deptCode: 'dx', roles: ['approver'] }, 'approver');
  expect(approver.held).toEqual(['approver']);
  expect(approver.optionValues).toEqual(['approver']);
  expect(approver.optionLabels).toEqual(['管理者（承認者（業務責任者））']);

  // 依頼者の役割だけを持つ利用者
  const requester = screenWith({ displayName: '一般利用者', deptCode: 'dx', roles: ['requester'] });
  expect(requester.optionValues).toEqual(['requester']);
  expect(requester.optionLabels).toEqual(['一般利用者（依頼者）']);

  // 3 役割を持つ利用者は 3 つ出る（並びは従来どおり requester → desk → approver）。名簿の名前は出さない
  const all = screenWith({ displayName: '管理者', deptCode: 'dx', roles: ['requester', 'desk', 'approver'] });
  expect(all.optionValues).toEqual(['requester', 'desk', 'approver']);
  expect(all.optionLabels).toEqual(['管理者（依頼者）', '管理者（受付担当（IT・DX））', '管理者（承認者（業務責任者））']);
  for (const name of ['山田 敏久', '石原 慎太郎', '鈴木 一郎', '佐藤 花子']) {
    expect(all.roleOpts).not.toContain(name);
  }
});

it('名簿（__SF_ACTORS__）は起票者・部署の選択では従来どおり使う', () => {
  // 起票者の初期値（blank）は名簿の代表者名のまま。表示名だけを名簿から切り離す。
  expect(js).toContain('const a=window.__SF_ACTORS__&&window.__SF_ACTORS__[role];');
  // 起票者の選択肢は、その部署の名簿から作る（applicantField）
  const applicantField = js.slice(js.indexOf('function applicantField('));
  expect(applicantField.slice(0, applicantField.indexOf('\n}\n'))).toContain('empOf(');
});

it('利用者が居るのに roles が読めないときは役割を出さない（fail-open にしない）', () => {
  const win = { __MSF__: { user: { displayName: '壊れた起動', deptCode: 'dx' } } } as unknown as FakeWindow;
  const scope: Scope = { window: win, ROLES, roleOf, E, S: { role: 'requester' } };
  const held = evaluate<() => Role[] | null>('heldRoles', scope, ['window', 'ROLES']);
  expect(held()).toEqual([]);
  const scope2: Scope = { ...scope, heldRoles: held };
  const holds = evaluate<(k: Role) => boolean>('holdsRole', scope2, ['heldRoles']);
  expect(holds('approver')).toBe(false);
  expect(holds('requester')).toBe(false);

  // 見本（サーバ非接続）は従来どおり全て可
  const sampleWin: FakeWindow = { __SF_ACTORS__: ACTORS };
  const sampleScope: Scope = { window: sampleWin, ROLES, roleOf, E, S: { role: 'requester' } };
  const sampleHeld = evaluate<() => Role[] | null>('heldRoles', sampleScope, ['window', 'ROLES']);
  const sampleScope2: Scope = { ...sampleScope, heldRoles: sampleHeld };
  const sampleHolds = evaluate<(k: Role) => boolean>('holdsRole', sampleScope2, ['heldRoles']);
  expect(sampleHolds('approver')).toBe(true);
});

it('役割の切替は、持っていない役割では画面を変えず、サーバの応答後にだけ変える（F-2 / F-3）', async () => {
  const calls: string[] = [];
  const toasts: { msg: string; kind?: string }[] = [];
  const state = { role: 'approver', open: null as string | null };
  const held = ['approver'];
  const holdsRole = (k: string): boolean => held.indexOf(k) >= 0;
  let switchResult = true;
  const switchRole = async (k: string): Promise<boolean> => {
    calls.push(`switch:${k}`);
    return switchResult;
  };
  const win = { __MSF__: { switchRole, user: null } };
  const select = { value: 'approver' };
  const setRole = new Function(
    'holdsRole',
    'window',
    'toast',
    'me',
    'S',
    'render',
    'renderDrawer',
    '$',
    `${fnDefOf('setRole')}\nreturn setRole;`,
  )(
    holdsRole,
    win,
    (msg: string, kind?: string) => toasts.push({ msg, kind }),
    () => ({ name: '管理者', l: '承認者（業務責任者）' }),
    state,
    () => calls.push('render'),
    () => calls.push('renderDrawer'),
    () => select,
  ) as (k: string) => Promise<void>;

  // 持っていない役割: サーバへも送らず、画面も変えず、エラーだけ出す。選択欄も元へ戻す
  select.value = 'requester';
  await setRole('requester');
  expect(state.role).toBe('approver');
  expect(calls).not.toContain('switch:requester');
  expect(select.value).toBe('approver');
  expect(toasts.at(-1)).toMatchObject({ kind: 'bad' });
  expect(toasts.at(-1)?.msg).toContain('権限がありません');

  // サーバが拒否した: 画面を変えず、選択欄も元へ戻す（拒否された役割として描画しない）
  switchResult = false;
  select.value = 'approver';
  await setRole('approver');
  expect(state.role).toBe('approver');
  expect(calls).not.toContain('render');
  expect(select.value).toBe('approver');

  // サーバが受け付けた: その後に画面を変える
  switchResult = true;
  await setRole('approver');
  expect(calls).toContain('render');
  expect(toasts.at(-1)?.msg).toContain('として操作します');
});

it('gateFor（DevOps / SecOps の操作ガード）も、保持する役割だけを切替候補にする', () => {
  const roleOf = (k: string) => ROLES.find((r) => r.k === k);
  const make = (heldRolesForUser: string[]): ((keys: string[]) => string) => {
    const S = { role: 'requester' };
    const holdsRole = (k: string) => heldRolesForUser.indexOf(k) >= 0;
    return new Function('may', 'CAN', 'roleOf', 'S', 'holdsRole', 'E', 'I', `${fnDefOf('gateFor')}\nreturn gateFor;`)(
      () => false,
      { transition: ['desk', 'approver'] },
      roleOf,
      S,
      holdsRole,
      (v: unknown) => String(v),
      () => '',
    ) as (keys: string[]) => string;
  };
  const none = make([])(['transition']);
  expect(none).not.toContain('に切り替え');
  const withDesk = make(['desk'])(['transition']);
  expect(withDesk).toContain('受付担当');
  expect(withDesk).not.toContain('承認者');
});

it('起動マーカーがあるのに接続できないときは、役割を出さない（fail-open にしない）', () => {
  const win = { __MSF__: null, __MSF_BOOT_FAILED__: true } as unknown as FakeWindow;
  const scope: Scope = { window: win, ROLES, roleOf, E, S: { role: 'requester' } };
  const held = evaluate<() => Role[] | null>('heldRoles', scope, ['window', 'ROLES']);
  expect(held()).toEqual([]);
});

it('「あなたの依頼」は名前ではなく applicantUserId で判定する（表示名と名簿名の不一致で消えない）', () => {
  expect(js).toContain('r.applicantUserId===myId');
});
