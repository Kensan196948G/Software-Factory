import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVIDENCE_DIR, RUN_ID } from './roles';

/**
 * 1 ラウンドの実行中に作った依頼の受付番号を、同じラウンドの A12（監査）へ渡す小さな記録。
 * リポジトリには入れない（test-results/ 配下）。ワーカーは 1 なので追記の競合は無い。
 */
interface RunState {
  requests: { id: string; by: string; at: string }[];
  notes: Record<string, unknown>;
}

// 実行（run-iso の 1 回）ごとに別ファイル。前回の DB は drop 済みなので、ID を持ち越さない。
const file = join(EVIDENCE_DIR, `run-state-${RUN_ID}.json`);

function read(): RunState {
  if (!existsSync(file)) return { requests: [], notes: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RunState;
    return { requests: parsed.requests ?? [], notes: parsed.notes ?? {} };
  } catch {
    return { requests: [], notes: {} };
  }
}

function write(state: RunState): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function recordRequest(id: string, by: string): void {
  const state = read();
  if (!state.requests.some((r) => r.id === id)) state.requests.push({ id, by, at: new Date().toISOString() });
  write(state);
}

export function recordedRequests(): string[] {
  return read().requests.map((r) => r.id);
}

export function recordNote(key: string, value: unknown): void {
  const state = read();
  state.notes[key] = value;
  write(state);
}

export function recordedNote<T = unknown>(key: string): T | null {
  return (read().notes[key] as T) ?? null;
}
