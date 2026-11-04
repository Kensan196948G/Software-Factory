#!/usr/bin/env node
/** Operator-only local provisioning. Does not create/fake an HTTP or Access session. */
import { lstatSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { addUserInteractively } from './add-user-flow.js';
import { safeAddUserError } from './add-user-errors.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      '本番ホストの所有者が実行する対話式登録。メールは引数に渡さない。\nMIRAI_SF_ENV_FILE="$HOME/.config/mirai-sf/prod.conf" node scripts/ops/with-env.mjs tsx scripts/ops/add-user.ts\n--check: 接続先・ローカル運用権限の読み取り確認のみ。',
    );
    return;
  }
  if (args.length && !(args.length === 1 && args[0] === '--check')) throw new Error('unsupported_arguments');
  const checkOnly = args[0] === '--check';
  if (!checkOnly && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('terminal_required');
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error('run_as_owner_not_root');
  const expectedFile = resolve(homedir(), '.config/mirai-sf/prod.conf');
  if (process.env.MIRAI_SF_ENV_FILE !== expectedFile) throw new Error('production_wrapper_required');
  const mode = lstatSync(expectedFile);
  if (!mode.isFile() || mode.uid !== uid || (mode.mode & 0o077) !== 0) throw new Error('config_owner_permissions');
  if (process.env.MIRAI_SF_CONFIG_FILE) throw new Error('mixed_configuration');
  // Discard inherited app/PG configuration; only this owner-controlled file supplies it.
  const values: Record<string, string> = {};
  for (const raw of readFileSync(expectedFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    if (eq < 1 || !/^[A-Z][A-Z0-9_]*$/.test(key) || key in values) throw new Error('invalid_config');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    values[key] = value;
  }
  const { env } = process;
  const safe = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TZ', 'TMPDIR', 'MIRAI_SF_ENV_FILE']);
  for (const key of Object.keys(env)) if (!safe.has(key) && !key.startsWith('LC_')) delete env[key];
  Object.assign(env, values);
  if (values.MIRAI_SF_CONFIG_FILE) throw new Error('mixed_configuration');
  // A future app/owner split can supply a separate maintenance URL without weakening the API.
  if (values.MIGRATION_DATABASE_URL) env.DATABASE_URL = values.MIGRATION_DATABASE_URL;
  if (!values.SEED_ADMIN_EMAIL || !values.ACCESS_TEAM_DOMAIN || !values.ACCESS_AUD || values.NODE_ENV !== 'production')
    throw new Error('security_config_required');
  const { config } = await import('../../src/api/config.js');
  const url = new URL(config.databaseUrl);
  if (
    config.appEnv !== 'production' ||
    config.authMode !== 'access' ||
    url.pathname !== '/mirai_sf_prod' ||
    url.hostname !== '' ||
    url.searchParams.get('host') !== '/var/run/postgresql'
  ) {
    throw new Error('wrong_environment');
  }
  const db = await import('../../src/api/db.js');
  try {
    // Verify actual connection too: env PG* variables must not silently select another DB/host.
    const identity = await db.one<{ db: string; db_user: string; local: boolean; privileged: boolean }>(
      `select current_database() as db, current_user as db_user, inet_server_addr() is null as local,
       (r.rolsuper or d.datdba=r.oid) as privileged
       from pg_roles r join pg_database d on d.datname=current_database() where r.rolname=current_user`,
    );
    if (
      !identity ||
      identity.db !== 'mirai_sf_prod' ||
      !identity.local ||
      !identity.privileged ||
      identity.db_user !== userInfo().username
    ) {
      throw new Error('local_operator_required');
    }
    const auth = await import('../../src/api/auth.js');
    const admin = await db.one<{ id: string }>(
      'select id from app_user where lower(email)=lower($1) and is_active and is_admin',
      [config.seedAdminEmail],
    );
    if (!admin) throw new Error('existing_admin_required');
    if (checkOnly) {
      console.log('事前確認OK: production / mirai_sf_prod / ローカルDB運用者 / 既存管理者。書込みなし。');
      return;
    }
    console.log(
      'ローカルDB運用権限で登録します（Access本人認証ではありません）。\n既存管理者IDを認可参照に使い、操作名と監査照合IDに local-cli を記録します。\n入力はシェル履歴に残しませんが、端末画面と通常の利用者監査には残ります。\n既存利用者は変更しません。Ctrl+Cで中止できます。',
    );
    const rl = createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
    const abort = new AbortController();
    let committing = false;
    rl.on('SIGINT', () => {
      if (committing) {
        console.log('書込み開始後です。完了結果を待ってください。');
        return;
      }
      abort.abort();
      rl.close();
    });
    rl.on('close', () => abort.abort());
    const actor: import('../../src/api/auth.js').LocalAdminActor = {
      userId: null,
      displayName: `local-cli uid=${uid}`,
      role: 'system',
      isAdmin: true,
      localAuthority: { method: 'local_db_owner', uid, authorizationAdminId: admin.id, accessLogin: false },
    };
    try {
      await addUserInteractively({
        actor,
        ask: (prompt) => rl.question(prompt, { signal: abort.signal }),
        print: (text) => console.log(text),
        findUser: async (email) => {
          const row = await db.one<{ id: string }>('select id from app_user where lower(email)=lower($1)', [email]);
          return row ? auth.getManagedUser(row.id) : null;
        },
        departmentExists: async (code) => Boolean(await db.one('select 1 from department where code=$1', [code])),
        emailAllowed: auth.isAccessEmailAllowed,
        create: async (input, localActor, correlationId) => {
          abort.signal.throwIfAborted();
          committing = true;
          console.log(`書込みを開始します。ここからは取消できません。監査照合ID: ${correlationId}`);
          return auth.createUser(input, localActor, correlationId);
        },
      });
    } finally {
      rl.close();
    }
  } finally {
    await db.closePool();
  }
}

main().catch((error: unknown) => {
  console.error(safeAddUserError(error));
  process.exitCode = 1;
});
