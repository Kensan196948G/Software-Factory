// scripts/ops/lib/offsite-recover-core.mjs の型（tests/unit/offsite-recover.test.ts が使う）。
export interface ListedObject {
  key: string;
  size: number;
  etag?: string | null;
}
export interface BackupKey {
  key: string;
  stamp: string;
  date: Date;
  kind: 'dump' | 'manifest';
}
export interface SelectedPair {
  stamp: string;
  date: Date;
  dump: { key: string; size: number; etag: string | null };
  manifest: { key: string; size: number; etag: string | null };
  ageHours: number;
  skipped: { stamp: string; why: 'future' | 'no-manifest' | 'no-dump' | 'empty' }[];
  considered: number;
}
export interface FreshnessOptions {
  now?: Date;
  maxAgeHours?: number;
  skewSeconds?: number;
}
export interface RecoverOptions {
  source: 'list' | 'guess';
  verifyOnly: boolean;
  out: string | null;
  maxAgeHours: number;
  from: Date | null;
  to: Date | null;
  maxProbes: number;
  help?: boolean;
}
export type WranglerFailureKind = 'not_found' | 'bucket_not_found' | 'auth' | 'rate_limited' | 'network' | 'signal' | 'unknown';
export interface WranglerFailure {
  kind: WranglerFailureKind;
  exit: number | null;
  signal: string | null;
  http: number | null;
  cfCode: number | null;
}

export const NAME_RE: RegExp;
export const BUCKET_RE: RegExp;
export const DEFAULT_MAX_AGE_HOURS: number;
export const MAX_AGE_HOURS_LIMIT: number;
export const DEFAULT_MAX_PROBES: number;
export const MAX_PROBES_LIMIT: number;
export const DEFAULT_SKEW_SECONDS: number;

export function parseStamp(stamp: string): Date | null;
export function formatStamp(date: Date): string;
export function normalizePrefix(prefix: string | null | undefined): string;
export function parseBackupKey(key: unknown, scope: { prefix: string; db: string }): BackupKey | null;
export function assessFreshness(
  date: Date,
  options?: FreshnessOptions,
): { ok: boolean; why: 'future' | 'stale' | null; ageHours: number };
export function assertFresh(stamp: string, date: Date, options?: FreshnessOptions): number;
export function parseListingPage(
  body: unknown,
  options?: { perPage?: number },
): { objects: { key: string; size: number; etag: string | null }[]; cursor: string | null; needsConfirm: boolean };
export function selectLatestPair(
  objects: readonly ListedObject[],
  options: { prefix: string; db: string } & FreshnessOptions,
): SelectedPair;
export function classifyEtag(etag: unknown): { kind: 'md5'; md5: string } | { kind: 'multipart'; parts: number };
export function candidateManifestKeys(options: {
  prefix: string;
  db: string;
  from: Date;
  to: Date;
  maxProbes?: number;
}): string[];
export function classifyWranglerFailure(result: {
  status: number | null;
  signal?: string | null;
  stderr?: string | null;
}): WranglerFailure;
export function describeFailure(failure: WranglerFailure): string;
export function parseManifest(text: string): { auditTip: string; tables: Map<string, number> };
export function tocTableCounts(tocText: string): Map<string, number>;
export function compareTocWithManifest(
  tocCounts: ReadonlyMap<string, number>,
  manifestTables: ReadonlyMap<string, number>,
): { ok: boolean; missing: string[]; extra: string[]; duplicate: string[] };
export function parseArgs(argv: readonly string[]): RecoverOptions;
export function isHeaderSafeToken(token: unknown): boolean;
export function encodeObjectKey(key: unknown): string;
export function buildR2Url(options: {
  apiBase?: string;
  accountId: string;
  bucket: string;
  key?: string | null;
  query?: Record<string, string> | null;
}): URL;
export function classifyFetchError(error: unknown): 'aborted' | 'timeout' | 'network' | 'unknown';
export function parseIsoWithZone(value: unknown): Date | null;
export interface SignalState {
  first: string | null;
  escalated: boolean;
}
export function nextSignalAction(
  state: SignalState,
  signal: string,
): { state: SignalState; action: { kind: 'forward' | 'kill'; signal: string } | { kind: 'none' } };
