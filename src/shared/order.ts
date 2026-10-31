import { DATA_HANDLING, DECIDES_LABEL, FREQUENCY_LABEL, KIND_LABEL, PARTY_LABEL, SIGNAL_LABEL, STATUS_LABEL } from './domain.js';
import type { FrequencyKey, Kind, Party, Signal, Status } from './domain.js';
import type { RequestRecord } from './types.js';

/** YAML の二重引用符文字列。改行は空白に置きかえる（詳細仕様書 6-1）。 */
function q(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const oneLine = text.replace(/\r?\n/g, ' ');
  return `"${oneLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function list(key: string, values: readonly string[]): string[] {
  const cleaned = values.map((v) => String(v).replace(/\r?\n/g, ' ').trim()).filter((v) => v !== '');
  if (cleaned.length === 0) return [`${key}: []`];
  return [`${key}:`, ...cleaned.map((v) => ` - ${q(v)}`)];
}

export interface OrderContext {
  request: RequestRecord;
  suggested: Signal;
  departmentName: string;
  catalogToolName: string;
  schemaVersion?: string;
}

/**
 * 注文書（作業指示書）YAML を生成する。
 * 形式は 詳細仕様書 6-1 の出力例に一致させる（テストで固定する）。
 */
export function buildOrderYaml(ctx: OrderContext): string {
  const r = ctx.request;
  const lines: string[] = [];
  lines.push(`schema_version: ${q(ctx.schemaVersion ?? '1.0')}`);
  lines.push(`order_version: ${r.orderVersion || 1}`);
  lines.push(`id: ${q(r.id)}`);
  lines.push(`title: ${q(r.title)}`);
  lines.push(`kind: ${q(KIND_LABEL[r.kind as Kind] ?? r.kind)}`);
  lines.push(`department: ${q(ctx.departmentName)}`);
  lines.push(`catalog_tool: ${q(ctx.catalogToolName || 'カタログ外')}`);
  lines.push(`requested_by: ${q(r.applicant)}`);
  lines.push(`approver: ${q(r.approver)}`);
  lines.push(`status: ${q(STATUS_LABEL[r.status as Status] ?? r.status)}`);
  lines.push('signal:');
  lines.push(`  suggested: ${q(SIGNAL_LABEL[ctx.suggested])}`);
  lines.push(`  decided: ${q(r.signalDecided ? SIGNAL_LABEL[r.signalDecided] : '未決定（承認者が決める）')}`);
  lines.push(...list('problem', [r.problem]));
  lines.push(...list('purpose', [r.purpose]));
  lines.push(...list('users', r.users));
  lines.push(...list('places', r.places));
  lines.push(...list('scope', r.scope));
  lines.push(...list('out_of_scope', r.outOfScope));
  lines.push(...list('acceptance_criteria', r.criteria));
  lines.push(...list('constraints', [...r.constraints, ...r.constraintsOther]));
  lines.push(...list('data_handling', dataHandlingLabels(r.dataHandling)));
  lines.push(`parties: ${q(PARTY_LABEL[r.parties as Party] ?? r.parties)}`);
  lines.push(...list('requires_human_approval', r.approvals));
  lines.push('measure:');
  lines.push(`  people: ${Number(r.people ?? 0)}`);
  lines.push(`  frequency: ${q(r.frequency ? (FREQUENCY_LABEL[r.frequency as FrequencyKey] ?? r.frequency) : '')}`);
  lines.push(`  minutes_per_time: ${Number(r.minutesPerTime ?? 0)}`);
  lines.push(`  est_hours_per_month: ${ctx.request.people ? estimateHours(r) : 0}`);
  lines.push(`requested_at: ${q(formatOrderDate(r.createdAt))}`);
  lines.push(`wish_date: ${q(r.wishDate ? formatWishDate(r.wishDate) : '')}`);
  return `${lines.join('\n')}\n`;
}

function dataHandlingLabels(keys: readonly string[]): string[] {
  if (keys.length === 0) return ['特別な情報は扱いません'];
  const labels: string[] = [];
  for (const key of keys) {
    const found = DATA_HANDLING.find((d) => d.key === key);
    if (found) labels.push(found.label);
  }
  return labels.length > 0 ? labels : [...keys];
}

function estimateHours(r: RequestRecord): number {
  const coefficient: Record<string, number> = { d: 20, w: 4, m: 1, o: 0.3 };
  const c = r.frequency ? (coefficient[r.frequency] ?? 0) : 0;
  const people = Number(r.people ?? 0);
  const minutes = Number(r.minutesPerTime ?? 0);
  if (!people || !minutes || !c) return 0;
  return Math.round(((people * c * minutes) / 60) * 10) / 10;
}

export function formatOrderDate(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}

function formatWishDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    d,
  );
}

/** 注文書で使う「この道具がすること」の説明（参考）。 */
export function decidesLabel(key: string): string {
  return DECIDES_LABEL[key as keyof typeof DECIDES_LABEL] ?? key;
}
