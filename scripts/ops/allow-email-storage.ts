import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';

export const JOURNAL_PHASES = [
  'prepared',
  'candidate_staged',
  'replacing',
  'replaced',
  'restarting',
  'verified',
  'rollback_staged',
  'rollback_replacing',
  'rollback_replaced',
  'rollback_restarting',
  'rollback_verified',
  'aborted_before_replace',
  'manual_recovery_required',
] as const;

export type JournalPhase = (typeof JOURNAL_PHASES)[number];

export type Journal = {
  readonly version: 1;
  readonly nonce: string;
  readonly pid: number;
  readonly phase: JournalPhase;
  readonly originalSha256: string;
  readonly candidateSha256: string;
  readonly backupPath: string;
  readonly updatedAt: string;
};

export type FileSnapshot = {
  readonly path: string;
  readonly text: string;
  readonly sha256: string;
  readonly dev: number;
  readonly ino: number;
};

export type StagedReplacement = {
  readonly snapshot: FileSnapshot;
  readonly replacementSha256: string;
  readonly tempPath: string;
  readonly tempDev: number;
  readonly tempIno: number;
};

export type LockLease = {
  readonly nonce: string;
  assertHeld(): void;
  release(): Promise<void>;
};

export class StorageError extends Error {
  constructor(
    readonly code: string,
    readonly detail = '',
  ) {
    super(code);
    this.name = 'StorageError';
  }
}

const journalSchema = z
  .object({
    version: z.literal(1),
    nonce: z.uuid(),
    pid: z.number().int().positive(),
    phase: z.enum(JOURNAL_PHASES),
    originalSha256: z.string().regex(/^[0-9a-f]{64}$/),
    candidateSha256: z.string().regex(/^[0-9a-f]{64}$/),
    backupPath: z.string().min(1),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T/),
  })
  .strict();

const terminalPhases = new Set<JournalPhase>(['verified', 'rollback_verified', 'aborted_before_replace']);

function failure(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertDirectory(path: string, uid: number, privateMode: boolean): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0) {
    throw new StorageError('unsafe_path', `${path}: owner/directory/mode`);
  }
}

export function ensurePrivateDirectory(path: string, uid: number): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (failure(error) !== 'EEXIST') throw new StorageError('unsafe_path', path);
  }
  assertDirectory(path, uid, true);
}

export function inspectCurrentDirectory(path: string, uid: number): string {
  const link = lstatSync(path);
  if (!link.isSymbolicLink() || link.uid !== uid) throw new StorageError('unsafe_path', path);
  const resolved = realpathSync(path);
  assertDirectory(resolved, uid, false);
  return resolved;
}

function readRegularText(path: string, uid: number, privateFile: boolean, maxBytes: number): FileSnapshot {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      stat.nlink !== 1 ||
      stat.size > maxBytes ||
      (stat.mode & (privateFile ? 0o077 : 0o022)) !== 0
    ) {
      throw new StorageError('unsafe_path', path);
    }
    const text = readFileSync(fd, 'utf8');
    return { path, text, sha256: sha256(text), dev: stat.dev, ino: stat.ino };
  } finally {
    closeSync(fd);
  }
}

export function readConfigSnapshot(path: string, uid: number): FileSnapshot {
  assertDirectory(dirname(path), uid, true);
  return readRegularText(path, uid, true, 1048576);
}

export function readReleaseSnapshot(path: string, uid: number): FileSnapshot {
  return readRegularText(path, uid, false, 4096);
}

function unlinkIfSame(path: string, dev: number, ino: number): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== dev || stat.ino !== ino) return false;
    unlinkSync(path);
    fsyncDirectory(dirname(path));
    return true;
  } catch (error) {
    if (failure(error) === 'ENOENT') return false;
    throw error;
  }
}

function writeExclusiveDurable(path: string, text: string): { dev: number; ino: number } {
  let fd: number | undefined;
  let identity: { dev: number; ino: number } | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(fd);
    identity = { dev: stat.dev, ino: stat.ino };
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(dirname(path));
    return identity;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the write failure.
      }
    }
    if (identity) {
      try {
        unlinkIfSame(path, identity.dev, identity.ino);
      } catch {
        // Preserve the write failure; the journal records recovery paths separately.
      }
    }
    throw new StorageError('write_failed', path);
  }
}

function assertSnapshotCurrent(snapshot: FileSnapshot, uid: number): void {
  const current = readConfigSnapshot(snapshot.path, uid);
  if (current.text !== snapshot.text || current.dev !== snapshot.dev || current.ino !== snapshot.ino) {
    throw new StorageError('config_changed', snapshot.path);
  }
}

export function stageReplacement(snapshot: FileSnapshot, replacement: string, tempPath: string, uid: number): StagedReplacement {
  if (
    resolve(tempPath) !== tempPath ||
    dirname(tempPath) !== dirname(snapshot.path) ||
    !basename(tempPath).startsWith(`${basename(snapshot.path)}.allow-email-`) ||
    !tempPath.endsWith('.tmp')
  ) {
    throw new StorageError('unsafe_path', tempPath);
  }
  assertSnapshotCurrent(snapshot, uid);
  const stat = writeExclusiveDurable(tempPath, replacement);
  return {
    snapshot,
    replacementSha256: sha256(replacement),
    tempPath,
    tempDev: stat.dev,
    tempIno: stat.ino,
  };
}

export function replaceStaged(staged: StagedReplacement, uid: number, onReplaced: () => void): void {
  assertSnapshotCurrent(staged.snapshot, uid);
  const temp = lstatSync(staged.tempPath);
  if (
    !temp.isFile() ||
    temp.isSymbolicLink() ||
    temp.uid !== uid ||
    temp.nlink !== 1 ||
    temp.dev !== staged.tempDev ||
    temp.ino !== staged.tempIno
  ) {
    throw new StorageError('unsafe_path', staged.tempPath);
  }
  // This is cooperative maintenance. A non-cooperating writer can still change the path after this check.
  try {
    renameSync(staged.tempPath, staged.snapshot.path);
  } catch {
    throw new StorageError('replace_failed', staged.snapshot.path);
  }
  onReplaced();
  try {
    fsyncDirectory(dirname(staged.snapshot.path));
  } catch {
    throw new StorageError('replace_after_rename', staged.snapshot.path);
  }
}

export function discardStaged(staged: StagedReplacement): string | undefined {
  try {
    unlinkIfSame(staged.tempPath, staged.tempDev, staged.tempIno);
    return undefined;
  } catch {
    return staged.tempPath;
  }
}

export function writeBackup(backupDir: string, uid: number, nonce: string, text: string): string {
  if (!/^[0-9a-f-]{36}$/.test(nonce)) throw new StorageError('unsafe_path', backupDir);
  ensurePrivateDirectory(backupDir, uid);
  const path = join(backupDir, `prod.conf.${nonce}.bak`);
  writeExclusiveDurable(path, text);
  return path;
}

export function writeJournal(path: string, journal: Journal): void {
  const parsed = journalSchema.safeParse(journal);
  if (!parsed.success) throw new StorageError('journal_invalid', path);
  const temp = join(dirname(path), `${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeExclusiveDurable(temp, `${JSON.stringify(parsed.data)}\n`);
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    try {
      const stat = lstatSync(temp);
      unlinkIfSame(temp, stat.dev, stat.ino);
    } catch {
      // Preserve the journal failure.
    }
    if (error instanceof StorageError) throw error;
    throw new StorageError('journal_write_failed', path);
  }
}

export function readJournal(path: string, backupDir: string, uid: number): Journal | null {
  try {
    lstatSync(path);
  } catch (error) {
    if (failure(error) === 'ENOENT') return null;
    throw new StorageError('journal_invalid', path);
  }
  const snapshot = readRegularText(path, uid, true, 65536);
  let value: unknown;
  try {
    value = JSON.parse(snapshot.text);
  } catch {
    throw new StorageError('journal_invalid', path);
  }
  const parsed = journalSchema.safeParse(value);
  if (!parsed.success || dirname(parsed.data.backupPath) !== backupDir) {
    throw new StorageError('journal_invalid', path);
  }
  return parsed.data;
}

export function journalIsTerminal(journal: Journal): boolean {
  return terminalPhases.has(journal.phase);
}

function prepareLockFile(path: string, uid: number): void {
  assertDirectory(dirname(path), uid, false);
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1) throw new StorageError('unsafe_path', path);
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

function lockState(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim().replaceAll('\n', ', ');
  } catch {
    return 'state=unknown';
  }
}

const lockScript = `
set -u
shared="$1"
specific="$2"
nonce="$3"
exec 8<>"$shared" || exit 70
exec 9<>"$specific" || exit 70
flock -n -E 75 8 || exit 75
flock -n -E 76 9 || exit 76
trap ':' INT TERM HUP
printf 'pid=%s\\nnonce=%s\\nstate=held\\n' "$$" "$nonce" >"$shared"
printf 'pid=%s\\nnonce=%s\\nstate=held\\n' "$$" "$nonce" >"$specific"
printf 'LOCKED\\n'
while IFS= read -r line; do
  [ "$line" = RELEASE ] && break
done
printf 'pid=%s\\nnonce=%s\\nstate=released\\n' "$$" "$nonce" >"$shared"
printf 'pid=%s\\nnonce=%s\\nstate=released\\n' "$$" "$nonce" >"$specific"
exit 0
`;

export async function acquireLocks(options: {
  readonly sharedPath: string;
  readonly filePath: string;
  readonly uid: number;
  readonly nonce: string;
}): Promise<LockLease> {
  prepareLockFile(options.sharedPath, options.uid);
  prepareLockFile(options.filePath, options.uid);
  const child = spawn('bash', ['-c', lockScript, 'allow-email-lock', options.sharedPath, options.filePath, options.nonce], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });
  await new Promise<void>((resolveLock, rejectLock) => {
    let ready = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectLock(new StorageError('lock_unavailable', 'flock acquisition timed out'));
    }, 5000);
    const settle = (error?: StorageError) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) rejectLock(error);
      else resolveLock();
    };
    const onData = (chunk: string) => {
      if (ready || !chunk.includes('LOCKED')) return;
      ready = true;
      settle();
    };
    const onError = () => settle(new StorageError('lock_unavailable', 'flock process could not start'));
    const onExit = (code: number | null) => {
      if (ready) return;
      const holder = `${lockState(options.sharedPath)} / ${lockState(options.filePath)}`;
      const detail =
        code === 75 || code === 76
          ? `cooperative flock is busy (${holder}). Do not delete lock files; inspect the listed PID and running operations.`
          : `flock exited (${code ?? 'signal'}): ${stderr.trim() || 'no detail'}`;
      settle(new StorageError(code === 75 || code === 76 ? 'lock_busy' : 'lock_unavailable', detail));
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });

  let released = false;
  return {
    nonce: options.nonce,
    assertHeld() {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new StorageError('lock_lost', 'cooperative flock process exited before the operation completed');
      }
    },
    async release() {
      if (released) return;
      released = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end('RELEASE\n');
      await new Promise<void>((resolveRelease, rejectRelease) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          rejectRelease(new StorageError('lock_release_failed', 'flock process did not release promptly'));
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolveRelease();
        });
      });
    },
  };
}
