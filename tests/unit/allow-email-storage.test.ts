import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  acquireLocks,
  discardStaged,
  journalIsTerminal,
  readConfigSnapshot,
  readJournal,
  replaceStaged,
  stageReplacement,
  writeBackup,
  writeJournal,
  type Journal,
} from '../../scripts/ops/allow-email-storage.js';
let dir: string, file: string;
const uid = process.getuid!();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sf-allow-test-'));
  chmodSync(dir, 0o700);
  file = join(dir, 'prod.conf');
  writeFileSync(file, 'synthetic-secret\n', { mode: 0o600 });
});
afterEach(() => {
  if (!resolve(dir).startsWith(resolve(tmpdir()) + '/sf-allow-test-')) throw new Error('cleanup path');
  rmSync(dir, { recursive: true });
});
describe('allowlist storage (isolated temporary files; no production/service writes)', () => {
  it('stages, replaces, and restores with checked snapshots', () => {
    const before = readConfigSnapshot(file, uid);
    const staged = stageReplacement(before, 'candidate\n', join(dir, 'prod.conf.allow-email-test.tmp'), uid);
    let replaced = false;
    replaceStaged(staged, uid, () => {
      replaced = true;
    });
    expect(replaced).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('candidate\n');
    expect(discardStaged(staged)).toBeUndefined();
    const rollback = stageReplacement(
      readConfigSnapshot(file, uid),
      before.text,
      join(dir, 'prod.conf.allow-email-rollback.tmp'),
      uid,
    );
    replaceStaged(rollback, uid, () => undefined);
    expect(readFileSync(file, 'utf8')).toBe(before.text);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });
  it('does not replace a concurrent edit and cleans only owned staged file', () => {
    const staged = stageReplacement(readConfigSnapshot(file, uid), 'candidate', join(dir, 'prod.conf.allow-email-test.tmp'), uid);
    writeFileSync(file, 'manual edit');
    expect(() =>
      replaceStaged(staged, uid, () => {
        throw new Error('not reached');
      }),
    ).toThrow('config_changed');
    expect(readFileSync(file, 'utf8')).toBe('manual edit');
    expect(discardStaged(staged)).toBeUndefined();
    expect(existsSync(staged.tempPath)).toBe(false);
  });
  it('rejects temp outside config directory and unsafe mode', () => {
    const snapshot = readConfigSnapshot(file, uid);
    expect(() => stageReplacement(snapshot, 'candidate', join(tmpdir(), 'wrong.tmp'), uid)).toThrow('unsafe_path');
    chmodSync(file, 0o644);
    expect(() => readConfigSnapshot(file, uid)).toThrow('unsafe_path');
  });
  it('keeps private backup and durable phase journal, no secret in journal', () => {
    const backupDir = join(dir, 'backup');
    const nonce = randomUUID();
    const snapshot = readConfigSnapshot(file, uid);
    const backupPath = writeBackup(backupDir, uid, nonce, snapshot.text);
    expect(readFileSync(backupPath, 'utf8')).toBe(snapshot.text);
    expect(lstatSync(backupDir).mode & 0o777).toBe(0o700);
    const journal: Journal = {
      version: 1,
      nonce,
      pid: process.pid,
      phase: 'replacing',
      originalSha256: snapshot.sha256,
      candidateSha256: snapshot.sha256,
      backupPath,
      updatedAt: new Date().toISOString(),
    };
    const path = join(backupDir, 'operation.json');
    writeJournal(path, journal);
    expect(readFileSync(path, 'utf8')).not.toContain('synthetic-secret');
    expect(journalIsTerminal(readJournal(path, backupDir, uid)!)).toBe(false);
    writeJournal(path, { ...journal, phase: 'verified' });
    expect(journalIsTerminal(readJournal(path, backupDir, uid)!)).toBe(true);
    expect(readdirSync(backupDir).filter((x) => x.endsWith('.tmp'))).toEqual([]);
  });
  it('cooperatively excludes overlapping operations and releases without deleting locks', async () => {
    const opts = { sharedPath: join(dir, '.ops.lock'), filePath: join(dir, '.email.lock'), uid, nonce: randomUUID() };
    const first = await acquireLocks(opts);
    try {
      first.assertHeld();
      await expect(acquireLocks({ ...opts, nonce: randomUUID() })).rejects.toThrow('lock_busy');
    } finally {
      await first.release();
    }
    expect(existsSync(opts.sharedPath)).toBe(true);
    const second = await acquireLocks({ ...opts, nonce: randomUUID() });
    await second.release();
  });
});
