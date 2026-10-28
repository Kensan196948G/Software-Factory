/**
 * みらいSF 受付ステーション — 共通ドメイン定義
 *
 * 正本: 要件定義書 V1.0（MSF-REQ-2026-001）7章 / 詳細仕様書 V1.0（MSF-SPC-2026-001）3章・5章
 * このファイルは API（サーバ側の正）と Web（表示）の両方から使う。
 * 画面の表示だけを信用せず、状態遷移・権限・信号判定は API 側で必ず再計算する。
 */

/* ────────────────────────────── 役割 ────────────────────────────── */

export const ROLES = ['requester', 'desk', 'approver'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  requester: '依頼者',
  desk: '受付担当',
  approver: '承認者',
};

/* ────────────────────────────── 状態 ────────────────────────────── */

export const STATUSES = [
  'received',
  'review',
  'wait',
  'approved',
  'dev',
  'verify',
  'field',
  'release_wait',
  'done',
  'back',
  'hold',
  'cancel',
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  received: '受付',
  review: '内容確認中',
  wait: '承認待ち',
  approved: '承認済み',
  dev: '実装中',
  verify: '検証中',
  field: '現場試用',
  release_wait: '公開承認待ち',
  done: '完了',
  back: '差戻し',
  hold: '見送り',
  cancel: '取消',
};

/** 正常系の並び（ボードの列）。差戻し・見送り・取消は別レーンに出す。 */
export const MAIN_FLOW: Status[] = [
  'received',
  'review',
  'wait',
  'approved',
  'dev',
  'verify',
  'field',
  'release_wait',
  'done',
];

/** 次の状態（「→ 次へ」の行き先）。無ければ null。 */
export const NEXT_STATUS: Partial<Record<Status, Status>> = {
  received: 'review',
  review: 'wait',
  wait: 'approved',
  approved: 'dev',
  dev: 'verify',
  verify: 'field',
  field: 'release_wait',
  release_wait: 'done',
  back: 'received',
};

export type TransitionTargets = Partial<Record<Status, Status>>;

/** 次に動かす人（NEXTBY）。 */
export const NEXT_BY: Partial<Record<Status, Role>> = {
  received: 'desk',
  review: 'desk',
  wait: 'approver',
  approved: 'desk',
  dev: 'desk',
  verify: 'desk',
  field: 'desk',
  release_wait: 'approver',
  back: 'requester',
};

export const CLOSED_STATUSES: Status[] = ['done', 'hold', 'cancel'];

/* ────────────────────────────── 選択肢 ────────────────────────────── */

export const KINDS = ['new_tool', 'improve_tool', 'bug_report', 'consult'] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABEL: Record<Kind, string> = {
  new_tool: '新しい道具がほしい',
  improve_tool: 'いまある道具を良くしたい',
  bug_report: '不具合の報告',
  consult: '相談・アイデア',
};

export const USERS = [
  '現場の担当者',
  '現場所長',
  '現場事務',
  '作業船の船長・船員',
  '潜水士',
  '本社の本部の担当者',
  '支店・営業所の担当者',
  '協力会社',
  '発注者（国・港湾管理者など）',
  '民間のお客様',
  '経営層',
] as const;

export const PLACES = ['事務所', '陸の現場（屋外）', '海の上（作業船・台船）', '電波の弱い現場', '移動中・車内'] as const;

export const DECIDES = ['g', 'y', 'r'] as const;
export type Decides = (typeof DECIDES)[number];
export const DECIDES_LABEL: Record<Decides, string> = {
  g: '記録・整理・検索・お知らせ',
  y: 'たたき台づくり・比べっこ・見落としチェック',
  r: '合否・金額・契約・人の処遇・安全を決める',
};

export const DATA_HANDLING = [
  { key: 'personal', label: '個人情報（名簿・資格・健康など）' },
  { key: 'client', label: '発注者から預かった図面・データ' },
  { key: 'location', label: '現場の位置情報' },
  { key: 'photo', label: '工事写真・検査記録の原本' },
  { key: 'money', label: 'お金の情報（金額・原価・支払い）' },
  { key: 'vessel', label: '作業船の運航・位置・点検の記録' },
  { key: 'env', label: '海の濁りなど環境の測定値' },
] as const;
export type DataKey = (typeof DATA_HANDLING)[number]['key'];

export const PARTIES = ['internal', 'partner', 'client'] as const;
export type Party = (typeof PARTIES)[number];
export const PARTY_LABEL: Record<Party, string> = {
  internal: '社内のみ',
  partner: '協力会社も使う',
  client: '発注者も見る',
};

export const CONSTRAINTS = [
  'いまのログイン方法は変えない',
  '本物のデータを練習用の場所に持ち込まない',
  '写真・記録の原本は加工しない',
  '個人情報は必要な人だけが見られるようにする',
  '電波がなくても入力が消えないようにする',
  '天気・波の予報は「目安」として見せ、作業するかどうかは表示しない',
] as const;

export const APPROVALS = [
  'データを消す・作り直す変更',
  'ログインや権限の変更',
  '新しい外部サービスとの接続',
  '協力会社・発注者に見せる範囲の変更',
  '提出様式の変更',
  '安全・品質の判定にかかわる変更',
  '作業船の運航・海の上の作業にかかわる変更',
] as const;

export const SAFETY_APPROVALS = ['安全・品質の判定にかかわる変更', '作業船の運航・海の上の作業にかかわる変更'] as const;

export const FREQUENCIES = [
  { key: 'd', label: '毎日', coefficient: 20 },
  { key: 'w', label: '毎週', coefficient: 4 },
  { key: 'm', label: '毎月', coefficient: 1 },
  { key: 'o', label: 'ときどき', coefficient: 0.3 },
] as const;
export type FrequencyKey = (typeof FREQUENCIES)[number]['key'];
export const FREQUENCY_COEFFICIENT: Record<FrequencyKey, number> = { d: 20, w: 4, m: 1, o: 0.3 };
export const FREQUENCY_LABEL: Record<FrequencyKey, string> = { d: '毎日', w: '毎週', m: '毎月', o: 'ときどき' };

export const DATA_READY = [
  { value: 5, label: '電子データでそろっている' },
  { value: 3, label: '一部は紙・Excel' },
  { value: 1, label: '紙や人の頭の中' },
] as const;

export const SPREAD = [
  { value: 5, label: '全社（海・陸・全支店）で使えそう' },
  { value: 3, label: 'いくつかの部署・支店・現場で使えそう' },
  { value: 1, label: '自分の部署・現場だけ' },
] as const;

export const TAILORING = ['T1', 'T2', 'T3'] as const;
export type Tailoring = (typeof TAILORING)[number];

/* ────────────────────────────── 信号 ────────────────────────────── */

export const SIGNALS = ['g', 'y', 'r'] as const;
export type Signal = (typeof SIGNALS)[number];
export const SIGNAL_LABEL: Record<Signal, string> = { g: '青', y: '黄', r: '赤' };
export const SIGNAL_RANK: Record<Signal, number> = { g: 0, y: 1, r: 2 };
export const SIGNAL_FROM_DECIDES: Record<Decides, Signal> = { g: 'g', y: 'y', r: 'r' };

export function higherSignal(a: Signal, b: Signal): Signal {
  return SIGNAL_RANK[a] >= SIGNAL_RANK[b] ? a : b;
}

export interface SignalInput {
  decides?: string | null;
  catalogSignal?: string | null;
  dataHandling?: readonly string[];
  parties?: string | null;
  approvals?: readonly string[];
}

export interface SignalVerdict {
  color: Signal;
  reasons: string[];
}

/**
 * 信号の色の候補（詳細仕様書 3-4、R1〜R6）。
 * 青から始め、当てはまるたびに引き上げる（下げない）。R3〜R6 は最大でも黄まで。
 */
export function evaluateSignal(input: SignalInput): SignalVerdict {
  let color: Signal = 'g';
  const reasons: string[] = [];

  const decides = input.decides ?? null;
  if (decides === 'g') {
    reasons.push('青：記録・整理・お知らせの道具です');
  } else if (decides === 'y') {
    color = higherSignal(color, 'y');
    reasons.push('黄：たたき台・チェックの道具は、担当者の確認が必要です');
  } else if (decides === 'r') {
    color = higherSignal(color, 'r');
    reasons.push('赤：「決める」仕事が入っています。AIに決めさせない範囲です');
  }

  const catalogSignal = input.catalogSignal ?? null;
  if (catalogSignal === 'y' || catalogSignal === 'r') {
    color = higherSignal(color, catalogSignal);
    reasons.push(`カタログ上の色が「${SIGNAL_LABEL[catalogSignal]}」の道具です`);
  }

  for (const key of input.dataHandling ?? []) {
    const found = DATA_HANDLING.find((d) => d.key === key);
    if (found) {
      color = higherSignal(color, 'y');
      reasons.push(`黄：${found.label}を扱います`);
    }
  }

  const parties = input.parties ?? 'internal';
  if (parties !== 'internal') {
    color = higherSignal(color, 'y');
    const label = PARTY_LABEL[parties as Party] ?? parties;
    reasons.push(`黄：社外の人（${label}）が関わります`);
  }

  const approvals = input.approvals ?? [];
  if (approvals.includes(SAFETY_APPROVALS[0])) {
    color = higherSignal(color, 'y');
    reasons.push('黄：安全・品質の判定にかかわります');
  }
  if (approvals.includes(SAFETY_APPROVALS[1])) {
    color = higherSignal(color, 'y');
    reasons.push('黄：作業船・海の上の作業にかかわります（出航・作業中止は人が決めます）');
  }

  if (reasons.length === 0) {
    reasons.push('まだ判定材料がありません（「この道具は何をしますか」を選んでください）');
  }

  return { color, reasons };
}

/* ────────────────────────────── 合格の条件 ────────────────────────────── */

export const PLACEHOLDERS = ['〇〇', '△△', '○○', '□□'] as const;

export const VAGUE_WORDS = [
  '使いやすい',
  '使い易い',
  '見やすい',
  'わかりやすい',
  '分かりやすい',
  'いい感じ',
  'いいかんじ',
  '適切',
  '適宜',
  'なるべく',
  'できるだけ',
  '早く',
  '速く',
  'すばやく',
  '簡単',
  'かんたん',
  '便利',
  'スムーズ',
  'きれい',
  'ちゃんと',
  'しっかり',
  '柔軟',
  '直感的',
  '快適',
  'いろいろ',
  'など',
] as const;

export type CriteriaCheckKind = 'empty' | 'placeholder' | 'vague' | 'short' | 'ok';

export interface CriteriaCheck {
  kind: CriteriaCheckKind;
  /** 画面に出す助言。empty のときは空文字。 */
  message: string;
  /** 文中で見つかったあいまい語（長い語から順）。 */
  vagueWords: string[];
}

/** 合格の条件の書き方チェック（詳細仕様書 3-3）。上から順に最初に当てはまったもの。 */
export function checkCriteria(raw: string): CriteriaCheck {
  const text = raw.trim();
  if (text === '') return { kind: 'empty', message: '', vagueWords: [] };

  const placeholder = PLACEHOLDERS.find((p) => text.includes(p));
  if (placeholder) {
    return {
      kind: 'placeholder',
      message: '「〇〇」「△△」の所を、自分の言葉に書きかえてください。',
      vagueWords: [],
    };
  }

  const found = [...VAGUE_WORDS]
    .filter((w) => text.includes(w))
    .sort((a, b) => b.length - a.length);

  if (found.length > 0) {
    return {
      kind: 'vague',
      message: `「${found[0]}」は人によって受け取り方がちがうため、検査機で合否を決められません。数字や「〜できる／〜できない」で書いてみましょう。`,
      vagueWords: found,
    };
  }

  if (text.length < 8) {
    return {
      kind: 'short',
      message: 'もう少し具体的に書きましょう（だれが・何を・どうなれば合格か）。',
      vagueWords: [],
    };
  }

  return { kind: 'ok', message: '検査で確かめられる書き方です。', vagueWords: [] };
}

export interface CriteriaTemplates {
  template: string;
}

export const CRITERIA_TEMPLATES: CriteriaTemplates[] = [
  { template: '〇〇しても消えない' },
  { template: '〇〇は自分の分だけが見られる' },
  { template: '同じ〇〇を二重に登録できない' },
  { template: '〇〇の翌朝9時までに通知される' },
  { template: '〇〇の記録（だれが・いつ）が残る' },
  { template: '〇〇は△△が「確定」を押すまで登録されない' },
];

export interface RewriteGroup {
  id: number;
  words: string[];
  hint: string;
  examples: string[];
}

/** あいまい語の書き換え候補（詳細仕様書 3-18）。 */
export const REWRITE_GROUPS: RewriteGroup[] = [
  {
    id: 1,
    words: ['使いやすい', '使い易い', '直感的', '簡単', 'かんたん', '便利', '快適', 'スムーズ'],
    hint: '「操作の回数」「かかる時間」「説明なしでできるか」で書くと検査できます',
    examples: [
      '〇〇まで3回以内の操作でたどり着ける',
      '初めての人が説明なしで〇〇を5分以内に終えられる',
      '手袋をしたままでも〇〇のボタンを押せる',
    ],
  },
  {
    id: 2,
    words: ['見やすい', 'わかりやすい', '分かりやすい', 'きれい'],
    hint: '「どこに・何が・どの大きさで出るか」で書くと検査できます',
    examples: [
      '〇〇が画面のいちばん上に表示される',
      '〇〇は色だけでなく文字でも区別できる',
      '屋外の明るさでも〇〇の文字が△△ポイント以上で表示される',
    ],
  },
  {
    id: 3,
    words: ['早く', '速く', 'すばやく'],
    hint: '「何秒・何分・いつまでに」を数字で書くと検査できます',
    examples: ['〇〇を押してから3秒以内に△△が表示される', '〇〇の翌営業日の朝9時までに△△へ通知される'],
  },
  {
    id: 4,
    words: ['なるべく', 'できるだけ', 'しっかり', 'ちゃんと', '適切', '適宜'],
    hint: '「必ず〜する」「〜のときは〜できない」と言い切ると検査できます',
    examples: ['〇〇が空のままでは登録できない', '〇〇のときは必ず△△に通知される', '〇〇は△△だけが見られる'],
  },
  {
    id: 5,
    words: ['柔軟', 'いろいろ', 'など'],
    hint: '対象をすべて書き出し、それ以外は「今回は作らない」へ回すと検査できます',
    examples: ['〇〇・△△・□□の3種類に対応する（それ以外は今回は作らない）'],
  },
  {
    id: 6,
    words: ['いい感じ', 'いいかんじ'],
    hint: '「何と比べて・どれくらいの差なら合格か」を書くと検査できます',
    examples: ['〇〇と△△の差が□□以内のときに合格とする', '〇〇は担当者が「確定」を押すまで登録されない'],
  },
];

/** その条件に当てはまる書き換え候補グループ。 */
export function rewriteGroupsFor(text: string): RewriteGroup[] {
  return REWRITE_GROUPS.filter((group) => group.words.some((w) => text.includes(w)));
}

/* ────────────────────────────── ものさし ────────────────────────────── */

export interface MeasureInput {
  people?: number | null;
  frequency?: string | null;
  minutesPerTime?: number | null;
}

/** 月あたり削減見込み（時間）。小数第1位。詳細仕様書 3-5。 */
export function computeMeasure({ people, frequency, minutesPerTime }: MeasureInput): number {
  const n = Number(people ?? 0);
  const m = Number(minutesPerTime ?? 0);
  const coefficient = frequency && frequency in FREQUENCY_COEFFICIENT ? FREQUENCY_COEFFICIENT[frequency as FrequencyKey] : 0;
  if (!Number.isFinite(n) || !Number.isFinite(m) || n <= 0 || m <= 0 || coefficient === 0) return 0;
  return Math.round(((n * coefficient * m) / 60) * 10) / 10;
}

export interface ScoreInput extends MeasureInput {
  signal?: Signal;
  dataReady?: number | null;
  spread?: number | null;
}

export interface ScoreRow {
  key: 'people' | 'signal' | 'measure' | 'data' | 'spread';
  label: string;
  score: number; // 0 = 未入力 / 1〜5
}

/** 5つの観点（1〜5点）。合計は出さない（BR-15）。 */
export function computeScore(input: ScoreInput): ScoreRow[] {
  const people = Number(input.people ?? 0);
  const hours = computeMeasure(input);
  const dataReady = Number(input.dataReady ?? 0);
  const spread = Number(input.spread ?? 0);

  const peopleScore = people >= 100 ? 5 : people >= 30 ? 4 : people >= 10 ? 3 : people >= 3 ? 2 : people > 0 ? 1 : 0;
  const signalScore = input.signal === 'g' ? 5 : input.signal === 'y' ? 3 : input.signal === 'r' ? 1 : 0;
  const measureScore = hours >= 150 ? 5 : hours >= 50 ? 4 : hours >= 20 ? 3 : hours >= 5 ? 2 : hours > 0 ? 1 : 0;
  const dataScore = dataReady === 5 ? 5 : dataReady === 3 ? 3 : dataReady === 1 ? 1 : 0;
  const spreadScore = spread === 5 ? 5 : spread === 3 ? 3 : spread === 1 ? 1 : 0;

  return [
    { key: 'people', label: '困っている人の多さ', score: peopleScore },
    { key: 'signal', label: '青信号か', score: signalScore },
    { key: 'measure', label: '手間の減り方', score: measureScore },
    { key: 'data', label: 'データがそろっているか', score: dataScore },
    { key: 'spread', label: 'ほかに広げられるか', score: spreadScore },
  ];
}

/* ────────────────────────────── 状態遷移の権限 ────────────────────────────── */

export interface TransitionActor {
  role: Role;
  userId: string;
  displayName: string;
}

export interface TransitionRequest {
  requestId: string;
  applicantUserId?: string | null;
  approverUserId?: string | null;
  approverName: string;
}

export interface TransitionOption {
  to: Status;
  allowed: boolean;
  /** 選べない理由（allowed=false のとき）。 */
  reason?: string;
  /** できる人（allowed=false のとき）。 */
  who?: Role;
  /** 理由（メモ）が必須か。 */
  requiresReason?: boolean;
}

const REASON_REQUIRED: Array<[Status, Status]> = [
  ['received', 'back'],
  ['review', 'back'],
  ['wait', 'back'],
  ['wait', 'hold'],
  ['release_wait', 'dev'],
  ['field', 'dev'],
];

export function isReasonRequired(from: Status, to: Status): boolean {
  return REASON_REQUIRED.some(([f, t]) => f === from && t === to) || to === 'cancel';
}

/** 本番の遷移表（詳細仕様書 3-6）。許可されている移動かだけを返す。 */
export function isTransitionDefined(from: Status, to: Status): boolean {
  if (from === to) return false;
  const map: Partial<Record<Status, Status[]>> = {
    received: ['review', 'back', 'hold', 'cancel'],
    review: ['wait', 'back', 'hold', 'cancel'],
    wait: ['approved', 'back', 'hold', 'cancel'],
    approved: ['dev', 'cancel'],
    dev: ['verify', 'wait', 'cancel'],
    verify: ['dev', 'field', 'release_wait', 'cancel'],
    field: ['release_wait', 'dev', 'cancel'],
    release_wait: ['done', 'dev', 'cancel'],
    back: ['received', 'hold', 'cancel'],
    done: [],
    hold: [],
    cancel: [],
  };
  return (map[from] ?? []).includes(to);
}

/** 役割ごとの可否（本番の権限）。 */
export function roleCanTransition(
  from: Status,
  to: Status,
  actor: TransitionActor,
  request: TransitionRequest,
  isOwner: boolean,
): { allowed: boolean; reason?: string; who?: Role } {
  if (!isTransitionDefined(from, to)) {
    return { allowed: false, reason: 'その状態へは変更できません', who: NEXT_BY[from] };
  }
  if (CLOSED_STATUSES.includes(from)) {
    if (from === 'done') return { allowed: false, reason: '完了した依頼を動かせるのは承認者だけです', who: 'approver' };
    return { allowed: false, reason: 'この依頼は終了しています（動かせません）', who: 'approver' };
  }

  if (actor.role === 'requester') {
    if (!isOwner) {
      return { allowed: false, reason: 'ほかの人の依頼は動かせません', who: 'desk' };
    }
    if (to === 'received' && from === 'back') return { allowed: true };
    if (to === 'hold' && (from === 'received' || from === 'back')) return { allowed: true };
    if (to === 'approved' || to === 'done') {
      return { allowed: false, reason: `「${STATUS_LABEL[to]}」にできるのは承認者だけです（最後は人が決めます）`, who: 'approver' };
    }
    return { allowed: false, reason: '依頼者が動かせるのは「差戻し→再提出」と「取り下げ」だけです。進め方は受付担当が決めます', who: 'desk' };
  }

  if (to === 'approved' || to === 'done') {
    if (actor.role !== 'approver') {
      return { allowed: false, reason: `「${STATUS_LABEL[to]}」にできるのは承認者だけです（最後は人が決めます）`, who: 'approver' };
    }
    // 承認待ち → 承認済み は、承認者本人（または承認者が空）の依頼だけ。
    if (from === 'wait' && request.approverUserId && request.approverUserId !== actor.userId) {
      return { allowed: false, reason: 'この依頼の承認者ではありません', who: 'approver' };
    }
    return { allowed: true };
  }

  // 受付担当・承認者は「承認済み」「完了」以外へ動かせる。ただし完了からは動かせない。
  if (from === 'done') return { allowed: false, reason: '完了した依頼は動かせません', who: 'approver' };
  return { allowed: true };
}

/** 画面に出す選択肢（allowed と理由つき）。 */
export function transitionOptions(
  from: Status,
  actor: TransitionActor,
  request: TransitionRequest,
  isOwner: boolean,
): TransitionOption[] {
  return STATUSES.filter((to) => to !== from).map((to) => {
    const verdict = roleCanTransition(from, to, actor, request, isOwner);
    return {
      to,
      allowed: verdict.allowed,
      ...(verdict.allowed ? {} : { reason: verdict.reason, who: verdict.who }),
      requiresReason: isReasonRequired(from, to),
    };
  });
}

/* ────────────────────────────── 滞留・あなたの番 ────────────────────────────── */

export const STALE_WARN_DAYS = 3;
export const STALE_DANGER_DAYS = 7;

/** 滞留日数（切り捨て）。詳細仕様書 3-17。 */
export function staleDays(since: string | Date, now: Date = new Date()): number {
  const from = typeof since === 'string' ? new Date(since) : since;
  const diff = now.getTime() - from.getTime();
  if (!Number.isFinite(diff) || diff < 0) return 0;
  return Math.floor(diff / 86_400_000);
}

export function staleLevel(days: number): 'ok' | 'warn' | 'danger' {
  if (days >= STALE_DANGER_DAYS) return 'danger';
  if (days >= STALE_WARN_DAYS) return 'warn';
  return 'ok';
}

export interface YourTurnCandidate {
  status: Status;
  applicantUserId?: string | null;
  approverUserId?: string | null;
  /** 「あなたの番」の対象か。 */
  target: boolean;
  /** すること（画面表示）。 */
  action: string;
}

/** 役割ごとの「あなたの番」（詳細仕様書 3-16）。 */
export function yourTurn(
  status: Status,
  actor: TransitionActor,
  request: { applicantUserId?: string | null; approverUserId?: string | null },
): YourTurnCandidate {
  const owner = Boolean(request.applicantUserId && request.applicantUserId === actor.userId);
  const isApprover = !request.approverUserId || request.approverUserId === actor.userId;

  if (actor.role === 'requester') {
    if (status === 'back' && owner) return { status, target: true, action: '指摘を直して再提出する' };
    if (status === 'field' && owner) return { status, target: true, action: '現場で使ってみて感想をコメントする' };
    return { status, target: false, action: '' };
  }
  if (actor.role === 'desk') {
    if (['received', 'review', 'approved', 'dev', 'verify', 'field'].includes(status)) {
      const actions: Partial<Record<Status, string>> = {
        received: '中身を確認して「内容確認中」へ',
        review: '注文書を整えて承認を依頼する',
        approved: '開発（AIで作る）を始める',
        dev: 'できあがりを検証へ回す',
        verify: '検査に合格したら現場試用へ',
        field: '試用結果を確認して公開承認待ちへ',
      };
      return { status, target: true, action: actions[status] ?? '' };
    }
    return { status, target: false, action: '' };
  }
  // approver
  if (status === 'wait' && isApprover) return { status, target: true, action: '信号の色を決めて、承認か差戻しを決める' };
  if (status === 'field') return { status, target: true, action: '試用の結果を見て公開承認待ちへ' };
  if (status === 'release_wait') return { status, target: true, action: '公開を承認して「完了」にする' };
  return { status, target: false, action: '' };
}

/* ────────────────────────────── 承認前チェック ────────────────────────────── */

export interface ChecklistItem {
  key: 'crit' | 'out' | 'data' | 'party' | 'safety' | 'red';
  status: 'warn' | 'ok';
  message: string;
  /** 画面に出すか（data/party/safety/red は「表示しない」= 参考情報）。 */
  visible: boolean;
}

export interface ChecklistInput {
  criteria: readonly string[];
  outOfScope: readonly string[];
  dataHandling: readonly string[];
  parties: string;
  approvals: readonly string[];
  decides?: string | null;
  suggested: Signal;
}

export function preApprovalChecklist(input: ChecklistInput): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const filled = input.criteria.map((c) => c.trim()).filter(Boolean);
  const bad = filled.filter((c) => checkCriteria(c).kind !== 'ok');

  if (filled.length === 0) {
    items.push({ key: 'crit', status: 'warn', visible: true, message: '合格の条件が1つもありません。検査機で合否を決められません' });
  } else if (bad.length > 0) {
    const first = checkCriteria(bad[0] as string);
    items.push({
      key: 'crit',
      status: 'warn',
      visible: true,
      message: `合格の条件 ${filled.length} 件のうち ${bad.length} 件が検査しにくい書き方です（例：${first.message}）`,
    });
  } else {
    items.push({ key: 'crit', status: 'ok', visible: true, message: `合格の条件 ${filled.length} 件は、すべて検査で確かめられる書き方です` });
  }

  if (input.outOfScope.map((s) => s.trim()).filter(Boolean).length === 0) {
    items.push({ key: 'out', status: 'warn', visible: true, message: '「今回は作らない」が空です。作りすぎ・手戻りのおそれがあります' });
  } else {
    items.push({ key: 'out', status: 'ok', visible: true, message: '「今回は作らない」が書かれています' });
  }

  const dataLabels: string[] = [];
  for (const key of input.dataHandling) {
    const found = DATA_HANDLING.find((d) => d.key === key);
    if (found) dataLabels.push(found.label);
  }
  if (dataLabels.length > 0) {
    items.push({
      key: 'data',
      status: 'warn',
      visible: true,
      message: `扱う情報：${dataLabels.join('、')}。見られる人の範囲と、練習用の場所に本物を持ち込まないことを確認`,
    });
  } else {
    items.push({ key: 'data', status: 'ok', visible: true, message: '特別な情報（個人情報・お金など）は扱いません' });
  }

  if (input.parties !== 'internal') {
    const label = PARTY_LABEL[input.parties as Party] ?? input.parties;
    items.push({ key: 'party', status: 'warn', visible: false, message: `社外の人（${label}）が関わります。見せる範囲を確認` });
  } else {
    items.push({ key: 'party', status: 'ok', visible: false, message: '' });
  }

  const safety = input.approvals.some((a) => (SAFETY_APPROVALS as readonly string[]).includes(a));
  items.push(
    safety
      ? { key: 'safety', status: 'warn', visible: false, message: '安全・品質／作業船の運航にかかわります。判定・出航・作業中止を道具に決めさせない作りか確認' }
      : { key: 'safety', status: 'ok', visible: false, message: '' },
  );

  const red = input.decides === 'r' || input.suggested === 'r';
  items.push(
    red
      ? { key: 'red', status: 'warn', visible: false, message: '赤信号の仕事（合否・金額・契約・処遇・安全を決める）が含まれます' }
      : { key: 'red', status: 'ok', visible: false, message: '' },
  );

  return items;
}

/** 承認時に必要な確認がそろっているか。 */
export interface ApprovalCheckInput extends ChecklistInput {
  decided: Signal;
  checklistAcknowledged: boolean;
  redAcknowledged: boolean;
  reason: string;
}

export function validateApproval(input: ApprovalCheckInput): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const items = preApprovalChecklist(input);
  const warns = items.filter((i) => i.status === 'warn' && i.visible).length;

  if (!input.decided) errors.push('信号の色を選んでください');
  if (warns > 0 && !input.checklistAcknowledged) errors.push('承認前チェックの △ を確認して、チェックを入れてください');
  if (input.decided === 'r' && !input.redAcknowledged) errors.push('赤信号の確認にチェックしてください');
  if (SIGNAL_RANK[input.decided] < SIGNAL_RANK[input.suggested] && input.reason.trim() === '') {
    errors.push('候補よりゆるい色にする理由をメモに書いてください');
  }
  return { ok: errors.length === 0, errors };
}

/* ────────────────────────────── 補助 ────────────────────────────── */

export function splitLines(values: readonly string[]): string[] {
  return values
    .flatMap((v) => String(v).split(/\r?\n/))
    .map((v) => v.replace(/^\s*[-・●]\s*/, '').trim())
    .filter((v) => v !== '');
}

export function formatJst(value: string | Date, opts: { withTime?: boolean } = {}): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  const fmt = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(opts.withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
  return fmt.format(d);
}

export function formatJstDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(typeof value === 'string' ? new Date(value) : value);
}

export function requestYearPrefix(year: number): string {
  return `REQ-${year}-`;
}

export const REQUEST_ID_PATTERN = /^REQ-\d{4}-\d{4}$/;
