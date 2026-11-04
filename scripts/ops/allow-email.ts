#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseProductionEnv, planSingleEmail } from './allow-email-config.js';
import { confirmInput } from './confirm-input.js';
import {
  acquireLocks,
  discardStaged,
  ensurePrivateDirectory,
  inspectCurrentDirectory,
  journalIsTerminal,
  readConfigSnapshot,
  readJournal,
  readReleaseSnapshot,
  replaceStaged,
  stageReplacement,
  writeBackup,
  writeJournal,
  type Journal,
  type JournalPhase,
  type StagedReplacement,
} from './allow-email-storage.js';

const unit = 'mirai-sf-prod-api.service';
const home = homedir();
const current = resolve(home, '.local/share/mirai-sf-prod/current');
const file = resolve(home, '.config/mirai-sf/prod.conf');
const backupDir = resolve(home, '.config/mirai-sf/allow-email-backups');
const journalPath = join(backupDir, 'operation.json');
const uid = process.getuid?.();
const system = (...args: string[]) =>
  execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim();
function fail(code: string): never {
  throw new Error(code);
}
function releaseCommit(): string {
  const directory = inspectCurrentDirectory(current, uid!);
  const text = readReleaseSnapshot(join(directory, 'release.env'), uid!).text;
  const match = /^COMMIT_SHA=([0-9a-f]{40})\s*$/.exec(text);
  if (!match || !directory.endsWith(`/releases/${match[1]}`)) fail('release_mismatch');
  return match[1]!;
}
function processMatches(values: Map<string, string>, commit: string): string {
  if (
    system('show', unit, '-p', 'WorkingDirectory', '--value') !== current ||
    system('show', unit, '-p', 'DropInPaths', '--value') !== '' ||
    releaseCommit() !== commit
  )
    fail('service_mismatch');
  if (system('show', unit, '-p', 'ActiveState', '--value') !== 'active') fail('service_mismatch');
  const pid = system('show', unit, '-p', 'MainPID', '--value');
  if (!/^[1-9][0-9]*$/.test(pid)) fail('service_mismatch');
  const env = new Map(
    readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 1)] as const;
      }),
  );
  if (env.has('MIRAI_SF_CONFIG_FILE')) fail('service_mismatch');
  for (const key of [
    'ACCESS_ALLOWED_EMAILS',
    'ACCESS_ALLOWED_DOMAIN',
    'ACCESS_SERVICE_TOKEN_IDS',
    'ACCESS_AUD',
    'ACCESS_TEAM_DOMAIN',
    'ALLOW_SELF_APPROVAL',
    'AUTH_MODE',
    'APP_ENV',
    'NODE_ENV',
    'MAIL_MODE',
  ]) {
    if ((env.get(key) ?? '') !== (values.get(key) ?? '')) fail('service_mismatch');
  }
  if (env.get('COMMIT_SHA') !== commit) fail('service_mismatch');
  return pid;
}
async function healthy(commit: string): Promise<void> {
  const r = await fetch('http://127.0.0.1:8783/healthz', { redirect: 'manual', signal: AbortSignal.timeout(3000) });
  if (r.status !== 200) fail('health_failed');
  const h = (await r.json()) as { status?: string; environment?: string; commit?: string; db?: { ok?: boolean } };
  if (h.status !== 'ok' || h.environment !== 'production' || !h.db?.ok || h.commit !== commit) fail('health_failed');
}
async function restartAndVerify(values: Map<string, string>, commit: string): Promise<void> {
  const oldPid = system('show', unit, '-p', 'MainPID', '--value');
  system('restart', unit);
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await healthy(commit);
      const pid = processMatches(values, commit);
      if (pid === oldPid) fail('service_mismatch');
      await delay(1000);
      await healthy(commit);
      if (processMatches(values, commit) !== pid) fail('service_mismatch');
      return;
    } catch {
      if (attempt === 19) fail('health_failed');
    }
    await delay(1000);
  }
}
function recoveryGate(): void {
  if (!existsSync(backupDir)) return;
  const previous = readJournal(journalPath, backupDir, uid!);
  if (previous && !journalIsTerminal(previous)) fail('recovery_required');
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      '本番ACCESS_ALLOWED_EMAILSへ1件だけ追加。[--check]は読取りのみ。メールは引数に渡さない。\n手動設定編集・配備・ロールバックを同時に行わない保守時間が必須。',
    );
    return;
  }
  if (args.length && !(args.length === 1 && args[0] === '--check')) fail('arguments');
  if (uid === undefined || uid === 0 || process.geteuid?.() !== uid) fail('owner_required');
  const check = args[0] === '--check';
  if (!check && (!process.stdin.isTTY || !process.stdout.isTTY)) fail('tty_required');
  const original = readConfigSnapshot(file, uid);
  const before = parseProductionEnv(original.text);
  const commit = releaseCommit();
  recoveryGate();
  await healthy(commit);
  const initialPid = processMatches(before, commit);
  if (check) {
    console.log('事前確認OK: 設定所有者/0600・本番JWT/自己承認禁止/メール停止・稼働設定/リリース一致・DB正常。変更なし。');
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
  const abort = new AbortController();
  let applying = false;
  const interrupt = () => {
    if (!applying) {
      abort.abort();
      rl.close();
    }
  };
  rl.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  process.on('SIGHUP', interrupt);
  process.on('SIGINT', interrupt);
  rl.on('close', () => abort.abort());
  const ask = (prompt: string) => rl.question(prompt, { signal: abort.signal });
  try {
    console.log('本番アプリの許可だけ追加しAPIを再起動します。Cloudflare/DB/メール送信は変更しません。');
    const first = await ask('追加する実際のメールアドレス: ');
    const plan = planSingleEmail(original.text, first, await ask('同じメールアドレスを再入力: '));
    if (!plan.changed) {
      console.log('既に許可対象。変更・再起動なし。');
      return;
    }
    console.log(`対象: sf-prod.mirai-dx-platform.com\n追加メール: ${plan.email}\n既存許可を残し本番APIの短時間中断があります。`);
    const print = (text: string) => console.log(text);
    if (!(await confirmInput(ask, print, 'Cloudflare側で同じ1件を本番アプリだけに保存済みですか？', 'CF-SAVED'))) return;
    if (!(await confirmInput(ask, print, '設定編集・配備・ロールバックを並行しない保守時間を確保していますか？', 'MAINTENANCE')))
      return;
    if (!(await confirmInput(ask, print, '本番APIを再起動して反映しますか？', 'APPLY'))) return;
    abort.signal.throwIfAborted();
    await healthy(commit);
    if (processMatches(before, commit) !== initialPid) fail('service_mismatch');
    abort.signal.throwIfAborted();
    applying = true;
    // Cooperative flock coordinates existing release/rollback. It cannot exclude a manual editor.
    const lease = await acquireLocks({
      sharedPath: resolve(home, '.local/share/mirai-sf-prod/.ops.lock'),
      filePath: resolve(home, '.config/mirai-sf/prod.conf.allow-email.flock'),
      uid,
      nonce: randomUUID(),
    });
    let staged: StagedReplacement | undefined;
    let journal: Journal | undefined;
    let replaced = false;
    const phase = (next: JournalPhase) => {
      if (!journal) fail('journal_invalid');
      journal = { ...journal, phase: next, updatedAt: new Date().toISOString() };
      writeJournal(journalPath, journal);
    };
    try {
      recoveryGate();
      lease.assertHeld();
      if (readConfigSnapshot(file, uid).sha256 !== original.sha256) fail('config_changed');
      ensurePrivateDirectory(backupDir, uid);
      const nonce = randomUUID();
      const backupPath = writeBackup(backupDir, uid, nonce, original.text);
      staged = stageReplacement(original, plan.text, resolve(home, `.config/mirai-sf/prod.conf.allow-email-${nonce}.tmp`), uid);
      journal = {
        version: 1,
        nonce,
        pid: process.pid,
        phase: 'prepared',
        originalSha256: original.sha256,
        candidateSha256: staged.replacementSha256,
        backupPath,
        updatedAt: new Date().toISOString(),
      };
      phase('candidate_staged');
      console.log(`退避ファイル: ${backupPath}\n復旧記録: ${journalPath}\n反映開始。ここからは取消できません。`);
      lease.assertHeld();
      phase('replacing');
      replaceStaged(staged, uid, () => {
        replaced = true;
      });
      phase('replaced');
      lease.assertHeld();
      phase('restarting');
      await restartAndVerify(parseProductionEnv(plan.text), commit);
      phase('verified');
      console.log(
        '反映成功: 個別許可を1件追加。実プロセス設定/本番DB/commit正常。\n管理者はブラウザを再読込してください。次に利用者登録を行い、本人OTPログインを確認します。',
      );
    } catch {
      if (!replaced) {
        if (journal) {
          try {
            phase('aborted_before_replace');
          } catch {
            /* Manual recovery gate remains fail closed. */
          }
        }
        console.error('反映前に停止。設定置換・API再起動はしていません。');
      } else {
        try {
          lease.assertHeld();
          const actual = readConfigSnapshot(file, uid);
          if (actual.text !== plan.text) fail('config_changed');
          const rollback = stageReplacement(
            actual,
            original.text,
            resolve(home, `.config/mirai-sf/prod.conf.allow-email-${randomUUID()}.tmp`),
            uid,
          );
          try {
            phase('rollback_staged');
            phase('rollback_replacing');
            replaceStaged(rollback, uid, () => undefined);
            phase('rollback_replaced');
          } finally {
            if (discardStaged(rollback)) console.error('警告: 復旧用一時ファイルの保全確認が必要です。');
          }
          phase('rollback_restarting');
          await restartAndVerify(before, commit);
          phase('rollback_verified');
          console.error('反映失敗。元の設定へ復旧してAPI正常を確認しました。Cloudflareの今回追加1件は別途取り消してください。');
        } catch {
          try {
            phase('manual_recovery_required');
          } catch {
            /* Existing nonterminal journal blocks retries. */
          }
          console.error(`自動復旧を確認できません。復旧記録: ${journalPath}。再実行せず確認を依頼してください。`);
        }
      }
      fail('apply_failed');
    } finally {
      if (staged && discardStaged(staged))
        console.error('警告: 設定を含む一時ファイルが残った可能性があります。確認を依頼してください。');
      try {
        await lease.release();
      } catch {
        console.error('警告: lock解放を確認できません。再実行せず確認を依頼してください。');
      }
    }
  } finally {
    rl.close();
    process.off('SIGTERM', interrupt);
    process.off('SIGHUP', interrupt);
    process.off('SIGINT', interrupt);
  }
}
const safe: Record<string, string> = {
  email_format: 'メール形式が不正です。',
  email_mismatch: '2回のメールが一致しません。',
  config_invalid: '設定に不正行/重複/未対応値があります。',
  security_config: '本番認証/自己承認禁止/メール停止の条件が不一致です。',
  service_identity_change: '既存サービストークンのidentityが変わるため停止しました。',
  config_changed: '別の操作で設定が変わりました。',
  service_mismatch: '設定と稼働が不一致です。',
  release_mismatch: 'リリース設定が未対応です。',
  owner_required: '本番設定の所有者ユーザーで実行してください（sudo不要）。',
  tty_required: 'Linux端末で直接実行してください。',
  unsafe_path: '設定/退避先の種類・所有者・権限を確認できません。',
  health_failed: '本番APIの正常性を確認できません。',
  arguments: '--check / --help 以外の引数は使えません。',
  apply_failed: '反映は完了していません。上の復旧結果を確認してください。',
  recovery_required: '前回操作の復旧確認が必要です。operation.jsonと退避ファイルを保持し、再実行せず調査を依頼してください。',
  lock_busy: '配備/設定の別操作が実行中です。lockファイルを消さず、終了を確認してください。',
  lock_unavailable: '保守lockを取得できません。',
};
main().catch((e: unknown) => {
  const code = e instanceof Error && Object.hasOwn(safe, e.message) ? e.message : 'unexpected';
  console.error(
    `停止 [${code}]: ${safe[code] ?? '中止または予期しない失敗。秘密値は表示しません。反映開始後なら復旧記録で確認し、再実行を待ってください。'}`,
  );
  process.exitCode = 1;
});
