// scripts/ops/offsite-recover.mjs の純粋関数の型（tests/unit/offsite-recover.test.ts が使う）。
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

export function parseStamp(stamp: string): Date | null;
export function formatStamp(date: Date): string;
export function normalizePrefix(prefix: string | null | undefined): string;
export function parseBackupKey(key: unknown, scope: { prefix: string; db: string }): BackupKey | null;
export function parseListingPage(body: unknown): {
  objects: { key: string; size: number; etag: string | null }[];
  cursor: string | null;
};
export function selectLatestPair(
  objects: readonly ListedObject[],
  options: { prefix: string; db: string; now?: Date; maxAgeHours?: number; skewSeconds?: number },
): SelectedPair;
export function candidateManifestKeys(options: {
  prefix: string;
  db: string;
  from: Date;
  to: Date;
  maxProbes?: number;
}): string[];
export function parseManifest(text: string): { auditTip: string; tables: Map<string, number> };
export function tocTableNames(tocText: string): Set<string>;
export function compareTocWithManifest(
  tocNames: ReadonlySet<string>,
  manifestTables: ReadonlyMap<string, number>,
): { ok: boolean; missing: string[]; extra: string[] };
export function md5FromEtag(etag: unknown): string | null;
export function parseArgs(argv: readonly string[]): RecoverOptions;
