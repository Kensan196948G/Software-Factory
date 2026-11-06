#!/usr/bin/env node
/**
 * 旧セッションの失効（運用 CLI）。既定は dry-run で、`--yes` を付けたときだけ削除する。
 *
 * 使い方:
 *   MIRAI_SF_ENV_FILE=~/.config/mirai-sf/prod.conf \
 *     node scripts/ops/with-env.mjs tsx scripts/ops/revoke-sessions.ts \
 *     --db mirai_sf_prod --cutoff 2026-11-06T05:10:01+09:00 --expect-count 21 \
 *     --reason "Access JWT 有効化に伴う旧セッション失効" --actor "owner"
 *
 * ガードは src/api/session-revoke.ts。条件を 1 つでも満たさなければ削除せず終了コード 2。
 * セッション ID・接続文字列・秘密は表示しない（件数と DB 名だけ）。
 */
import { revokeSessions, type SessionRevokeAbortReason, type SessionRevokeOutcome } from '../../src/api/session-revoke.js';

interface CliOptions {
  db: string;
  cutoff: string;
  expectCount: number;
  reason: string;
  actor: string;
  maxCount?: number;
  allowActive: boolean;
  correlationId?: string;
  dryRun: boolean;
}

const USAGE = `使い方: tsx scripts/ops/revoke-sessions.ts --db <DB名> --cutoff <ISO8601> --expect-count <件数> --reason <理由> --actor <実行者> [--max-count <上限>] [--allow-active] [--dry-run | --yes]

  --db            接続先として期待する DB 名（current_database() と一致しなければ中止）
  --cutoff        この時刻より前に作成されたセッションだけを対象にする（例: 2026-11-06T05:10:01+09:00）
  --expect-count  削除予定件数（実際の対象件数と一致しなければ中止）
  --reason        監査に残す理由（必須・200 文字以内）
  --actor         監査に残す実行者（必須・100 文字以内。個人情報ではなく役割や uid）
  --max-count     1 回に削除してよい上限（既定 100、最大 1000）
  --allow-active  有効なセッションがあっても続行する（既定は中止）
  --dry-run       検証だけ行う（既定）
  --yes           実際に削除する（--dry-run と同時指定は不可）

終了コード: 0=成功（dry-run 含む） / 2=ガード不成立で中止（DB は変更しない） / 1=想定外の失敗`;

type Parsed = { kind: 'help' } | { kind: 'error'; message: string } | { kind: 'run'; options: CliOptions };

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const takesValue = new Set(['db', 'cutoff', 'expect-count', 'reason', 'actor', 'max-count', 'correlation-id']);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (!arg.startsWith('--')) return { kind: 'error', message: `位置引数は受け付けません: ${arg}` };

    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    const inline = eq >= 0 ? body.slice(eq + 1) : undefined;

    if (name === 'dry-run' || name === 'yes' || name === 'allow-active') {
      if (inline !== undefined) return { kind: 'error', message: `--${name} は値を取りません` };
      flags.add(name);
      continue;
    }
    if (!takesValue.has(name)) return { kind: 'error', message: `不明なオプションです: ${arg}` };

    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return { kind: 'error', message: `--${name} には値が必要です` };
      value = next;
      i += 1;
    }
    if (!value) return { kind: 'error', message: `--${name} の値が空です` };
    if (values.has(name)) return { kind: 'error', message: `--${name} が重複しています` };
    values.set(name, value);
  }

  const dryRunFlag = flags.has('dry-run');
  const yes = flags.has('yes');
  if (dryRunFlag && yes) return { kind: 'error', message: '--dry-run と --yes は同時に指定できません' };

  const expectRaw = values.get('expect-count');
  const maxRaw = values.get('max-count');
  const correlationId = values.get('correlation-id');

  return {
    kind: 'run',
    options: {
      db: values.get('db') ?? '',
      cutoff: values.get('cutoff') ?? '',
      // 数値の妥当性はコア関数が検証する（ここでは変換だけ）。
      expectCount: expectRaw === undefined ? Number.NaN : Number(expectRaw),
      reason: values.get('reason') ?? '',
      actor: values.get('actor') ?? '',
      maxCount: maxRaw === undefined ? undefined : Number(maxRaw),
      allowActive: flags.has('allow-active'),
      correlationId: correlationId === undefined ? undefined : correlationId,
      dryRun: !yes,
    },
  };
}

const ABORT_MESSAGES: Record<SessionRevokeAbortReason, string> = {
  invalid_db_name: '--db が不正です（英数字と _ のみ・1〜63 文字）',
  invalid_cutoff: '--cutoff が不正です（タイムゾーン付きの ISO 8601 で指定してください）',
  cutoff_in_future: '--cutoff が現在より未来です',
  invalid_expect_count: '--expect-count が不正です（1 以上かつ --max-count 以下）',
  invalid_max_count: '--max-count が不正です（1〜1000）',
  reason_required: '--reason が必要です',
  invalid_reason: '--reason が長すぎます（200 文字以内）',
  actor_required: '--actor が必要です',
  invalid_actor: '--actor が長すぎます（100 文字以内）',
  db_name_mismatch: '接続先の DB が --db と一致しません',
  active_sessions: '有効なセッションが残っています（--allow-active が無いため中止）',
  sessions_after_cutoff: 'cutoff 以後に作成されたセッションがあります（cutoff を見直してください）',
  count_exceeds_max: '対象件数が上限を超えています',
  count_mismatch: '対象件数が --expect-count と一致しません',
  delete_count_mismatch: '削除件数が検証と一致しませんでした（ロールバック済み）',
};

function printOutcome(outcome: SessionRevokeOutcome): void {
  if (!outcome.ok) {
    const report = outcome.report;
    console.error(`[revoke-sessions] 中止: ${ABORT_MESSAGES[outcome.abortReason]}。削除していません。`);
    if (report) {
      const db = report.db ?? '(不明)';
      console.error(
        `[revoke-sessions] 参考: db=${db} 対象候補=${report.candidates ?? '-'} 有効=${report.activeSessions ?? '-'} cutoff以後=${report.sessionsAfterCutoff ?? '-'}`,
      );
    }
    return;
  }

  console.log(
    `[revoke-sessions] ${outcome.dryRun ? 'dry-run' : '実行'} db=${outcome.db} cutoff=${outcome.cutoff} 期待件数=${outcome.expectCount} 上限=${outcome.maxCount}`,
  );
  console.log(
    `[revoke-sessions] 対象候補=${outcome.candidates} 有効=${outcome.activeSessions} cutoff以後=${outcome.sessionsAfterCutoff} 削除=${outcome.deleted}`,
  );
  if (outcome.dryRun) {
    console.log('[revoke-sessions] dry-run のため変更していません。実行するには --yes を付けてください。');
    return;
  }
  if (outcome.audit) {
    console.log(`[revoke-sessions] 監査に記録しました: id=${outcome.audit.id} hash=${outcome.audit.hash}`);
  } else {
    console.log('[revoke-sessions] 監査行がありません（想定外です。確認してください）');
  }
}

/** 接続文字列などをエラーメッセージから伏せる。 */
function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/postgres(?:ql)?:\/\/\S+/gi, '<接続文字列>').slice(0, 300);
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (parsed.kind === 'error') {
    console.error(`[revoke-sessions] ${parsed.message}`);
    console.error(USAGE);
    return 2;
  }

  const { closePool } = await import('../../src/api/db.js');
  try {
    const outcome = await revokeSessions(parsed.options);
    printOutcome(outcome);
    return outcome.ok ? 0 : 2;
  } finally {
    await closePool();
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[revoke-sessions] エラー: ${safeError(error)}`);
    process.exitCode = 1;
  });
