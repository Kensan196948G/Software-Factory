/**
 * 開発ライン 実 runner の1件実走の入口。手順と前提は docs/devline/real-runner.md。
 *
 *   node scripts/local-run.mjs tsx scripts/devline-real-run.ts              既定は --dry-run（送信なし）
 *   node scripts/local-run.mjs tsx scripts/devline-real-run.ts --confirm-real-run
 *
 * dry-run は資格情報のファイルを開かず、DB にも GitHub にも Anthropic にも接続しない。
 * 実走は作り物の注文書で1回だけ、Sandbox リポジトリへ。job は pr_ready（人の承認待ち）で止まる。
 * 各段階は「実行確認済み / 未到達 / 失敗」で出す。実行していないものを成功と書かない。
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { REAL_RUNNER_POLICY, SANDBOX_REPO, SANDBOX_DIFF_POLICY, parseDevlineTargetRepos } from '../src/shared/devline.js';
import type { OrderEnvelopeV1, RunnerInput } from '../src/shared/devline.js';
import {
  PROXY_IMAGE,
  RUNNER_IMAGE,
  buildClaudeArgs,
  buildDockerRunArgs,
  buildRunnerPrompt,
} from '../src/worker/docker-claude-runner.js';
import { checkRealLineEnv, parseRunnerBudget } from '../src/worker/real-line.js';

export type StageStatus = '実行確認済み' | '未到達' | '失敗' | '確認のみ（送信なし）';

export const REAL_STAGES = [
  '設定の検査',
  '資格情報の読み込み',
  'runner イメージの確認',
  '対象リポジトリの確認（ID・private）',
  '作り物の依頼の用意',
  'Issue の投入（handoff）',
  '計画（AI）',
  '実装と差分検査（AI・ホスト）',
  'push と PR の作成',
  '独立 CI の収集',
  'pr_ready（人の承認待ち）',
  'PR 本文の更新',
] as const;
export type RealStage = (typeof REAL_STAGES)[number];

/** 作り物の注文書。実在の人名・現場・図書を入れない。 */
export const SYNTHETIC_ORDER = {
  title: '【作り物】Sandbox の文字列整形関数',
  kind: 'improve_tool',
  deptCode: 'dx',
  applicant: '作り物 太郎',
  contact: '内線 0000',
  toolId: null,
  problem: '開発ラインの接続確認のための作り物の依頼です。実在の業務とは関係ありません。',
  purpose: 'src/ に小さな純関数を1つ追加し、test/ に試験を追加して CI を通す。',
  users: ['本社の本部の担当者'],
  people: 1,
  places: [] as string[],
  scope: ['src/format-title.js に、前後の空白を除いて先頭を大文字にする関数 formatTitle を追加する'],
  outOfScope: ['既存ファイルの変更', '依存パッケージの追加'],
  criteria: ['formatTitle("  hello ") が "Hello" を返す', '空文字列は空文字列を返す'],
  decides: 'g',
  dataHandling: [] as string[],
  parties: 'internal',
  constraints: [] as string[],
  constraintsOther: [] as string[],
  approvals: [] as string[],
  frequency: 'o',
  minutesPerTime: 5,
  dataReady: 5,
  spread: 5,
  approver: '作り物 花子',
};

export function formatStages(
  stages: Partial<Record<RealStage, StageStatus>>,
  details: Partial<Record<RealStage, string>> = {},
): string {
  return REAL_STAGES.map((name) => {
    const status = stages[name] ?? '未到達';
    const detail = details[name] ? `（${details[name]}）` : '';
    return `  ${status.padEnd(10, '　')} ${name}${detail}`;
  }).join('\n');
}

/** dry-run: 組み立てだけを確かめる。接続しない。資格情報のファイルを開かない。 */
export function dryRunReport(env: Record<string, string | undefined>): { text: string; ok: boolean } {
  const details: Partial<Record<RealStage, string>> = {};
  const stages: Partial<Record<RealStage, StageStatus>> = {};
  const allowed = parseDevlineTargetRepos(env.DEVLINE_TARGET_REPOS ?? `${SANDBOX_REPO.name}:${SANDBOX_REPO.repoId}`);
  const refused = checkRealLineEnv(env, allowed);
  stages['設定の検査'] = refused ? '失敗' : '確認のみ（送信なし）';
  if (refused) details['設定の検査'] = refused;
  else {
    const budget = parseRunnerBudget(env);
    details['設定の検査'] =
      `予算 ${budget.limitJpy} 円・${budget.jpyPerUsd} 円/USD・対象 ${allowed.map((r) => r.name).join(',')}`;
  }
  const envelope: OrderEnvelopeV1 = {
    schema: 'msf.order-envelope/v1',
    request_id: 'REQ-0000-0000',
    order_version: 1,
    content_sha256: '0'.repeat(64),
    approval: {
      id: '00000000-0000-0000-0000-000000000000',
      approver_user_id: '00000000-0000-0000-0000-000000000000',
      decided_signal: 'g',
      suggested_signal: 'g',
      approved_at: '2026-01-01T00:00:00.000Z',
    },
    target_repo_id: SANDBOX_REPO.name,
    base_sha: '0'.repeat(40),
    policy_version: 'devline-policy/v1',
    frozen_at: '2026-01-01T00:00:00.000Z',
  };
  const input: RunnerInput = {
    jobId: '00000000-0000-0000-0000-000000000000',
    attemptNo: 1,
    step: 'implement',
    order: {
      envelope,
      canonicalYaml: `id: "REQ-0000-0000"\ntitle: ${JSON.stringify(SYNTHETIC_ORDER.title)}\nrequested_by: "x"\n`,
    },
    acceptanceCriteriaIds: ['AC-1', 'AC-2'],
    policyVersion: 'devline-policy/v1',
    baseSha: envelope.base_sha,
    deadlineAt: '2026-01-01T01:00:00.000Z',
    signal: new AbortController().signal,
  };
  const prompt = buildRunnerPrompt(input);
  const args = buildDockerRunArgs({
    containerName: 'msf-dl-run-dryrun',
    network: 'msf-dl-int-dryrun',
    proxyName: 'msf-dl-proxy-dryrun',
    workTree: '/tmp/work',
    image: RUNNER_IMAGE,
    user: { uid: 1000, gid: 1000 },
    memory: '2g',
    cpus: '2',
    pidsLimit: 256,
    timeoutSeconds: 1830,
    claudeArgs: buildClaudeArgs({ prompt: '<PROMPT>', step: 'implement', maxTurns: 40, maxBudgetUsd: 6.25 }),
  });
  const lines = [
    '== 開発ライン 実 runner の1件実走: dry-run（送信なし） ==',
    '資格情報のファイル: 開いていません',
    `runner イメージ: ${RUNNER_IMAGE} / プロキシ: ${PROXY_IMAGE}（存在の確認は実走時）`,
    `対象: ${SANDBOX_REPO.name} / 差分 policy: ${SANDBOX_DIFF_POLICY.version} / CI: ${REAL_RUNNER_POLICY.ciWorkflowPath}`,
    `プロンプトの大きさ: ${Buffer.byteLength(prompt, 'utf8')} bytes（氏名欄 requested_by を含まない: ${!prompt.includes('requested_by')}）`,
    'docker の引数（プロンプトと値は載せていない）:',
    `  docker ${args.join(' ')}`,
    '',
    '各段階:',
    formatStages(stages, details),
    '',
    '実走には --confirm-real-run が必要です。',
  ];
  return { text: lines.join('\n'), ok: !refused };
}

async function realRun(env: NodeJS.ProcessEnv): Promise<boolean> {
  const stages: Partial<Record<RealStage, StageStatus>> = {};
  const details: Partial<Record<RealStage, string>> = {};
  const report = (): void => console.log(`\n各段階:\n${formatStages(stages, details)}`);

  const allowed = parseDevlineTargetRepos(env.DEVLINE_TARGET_REPOS ?? `${SANDBOX_REPO.name}:${SANDBOX_REPO.repoId}`);
  const refused = checkRealLineEnv(env, allowed);
  if (refused) {
    stages['設定の検査'] = '失敗';
    details['設定の検査'] = refused;
    report();
    return false;
  }
  // 工場の Staging や通常の DB で実走しない
  // 読めない URL の例外には接続文字列が載るので、外へ出さない
  const dbName = (() => {
    try {
      return new URL(env.DATABASE_URL ?? 'postgresql://invalid/').pathname.replace(/^\//, '');
    } catch {
      return '';
    }
  })();
  if (!/_(dev|test|devline)$/.test(dbName)) {
    stages['設定の検査'] = '失敗';
    details['設定の検査'] = 'DATABASE_URL は _dev / _test / _devline で終わる DB にしてください';
    report();
    return false;
  }
  stages['設定の検査'] = '実行確認済み';

  // 依頼の作成で外部へ送らない
  process.env.MAIL_MODE = 'off';
  process.env.DEVLINE_TARGET_REPOS = `${SANDBOX_REPO.name}:${SANDBOX_REPO.repoId}`;
  const { config } = await import('../src/api/config.js');
  const { closePool, pool, query } = await import('../src/api/db.js');
  const { seedMaster } = await import('../src/api/seed.js');
  const { requestInputSchema, transitionSchema } = await import('../src/api/schemas.js');
  const { actorOf, createRequest, performTransition } = await import('../src/api/service.js');
  const { handoffOrder } = await import('../src/api/devline-handoff.js');
  const { getJobView } = await import('../src/api/devline-jobs.js');
  const { createGithubIssueAdapter } = await import('../src/api/issue-adapter.js');
  const { loadDevlineSecrets, DEFAULT_SECRETS_PATH, startRealLine } = await import('../src/worker/real-line.js');
  const { runOnce } = await import('../src/worker/loop.js');

  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());

  const pollMs = env.DEVLINE_CI_POLL_MS ? Number(env.DEVLINE_CI_POLL_MS) : null;
  let closeLine: (() => Promise<void>) | null = null;
  try {
    const secretsPath = env.DEVLINE_SECRETS_FILE ?? DEFAULT_SECRETS_PATH;
    const secrets = loadDevlineSecrets(secretsPath, config.nodeEnv);
    stages['資格情報の読み込み'] = '実行確認済み';
    const line = await startRealLine({
      env,
      allowedRepos: allowed,
      nodeEnv: config.nodeEnv,
      apiUrl: config.githubApiUrl,
      secretsPath,
      ...(pollMs === null ? {} : { minPollIntervalMs: pollMs }),
    });
    closeLine = line.close;
    stages['runner イメージの確認'] = '実行確認済み';
    stages['対象リポジトリの確認（ID・private）'] = '実行確認済み';

    // 作り物の利用者と依頼
    const client = await pool.connect();
    try {
      await seedMaster(client);
    } finally {
      client.release();
    }
    const email = 'devline-realrun@example.invalid';
    await query(
      `insert into app_user (email, display_name, dept_code, password_hash, is_admin)
       values ($1,'作り物 太郎','dx','!disabled-login!',false) on conflict (email) do nothing`,
      [email],
    );
    const user = (await query<{ id: string }>('select id from app_user where email=$1', [email])).rows[0] as { id: string };
    for (const role of ['requester', 'desk', 'approver']) {
      await query('insert into user_role (user_id, role) values ($1,$2) on conflict do nothing', [user.id, role]);
    }
    const session = {
      id: user.id,
      email,
      displayName: '作り物 太郎',
      deptCode: 'dx',
      isAdmin: false,
      roles: ['requester', 'desk', 'approver'] as ('requester' | 'desk' | 'approver')[],
    };
    const actor = (role: 'requester' | 'desk' | 'approver') => actorOf({ ...session, actingRole: role });
    const cid = `real-run-${randomUUID()}`;
    const created = await createRequest(requestInputSchema.parse(SYNTHETIC_ORDER), actor('requester'), cid);
    const id = created.id;
    const step = async (role: 'desk' | 'approver', body: Record<string, unknown>): Promise<void> => {
      const row = (await query<{ version: number }>('select version from request where id=$1', [id])).rows[0] as {
        version: number;
      };
      await performTransition(id, transitionSchema.parse({ version: row.version, ...body }), actor(role), cid);
    };
    await step('desk', { to: 'review' });
    await step('desk', { to: 'wait' });
    await step('approver', { to: 'approved', signal: 'g', checklistAcknowledged: true, reason: '作り物の承認（1件実走）' });
    stages['作り物の依頼の用意'] = '実行確認済み';
    details['作り物の依頼の用意'] = id;

    const handed = await handoffOrder({ requestId: id, orderVersion: null }, actor('desk'), cid, {
      issueAdapter: createGithubIssueAdapter({
        token: secrets.githubToken,
        apiUrl: config.githubApiUrl,
        nodeEnv: config.nodeEnv,
      }),
      targetRepo: SANDBOX_REPO.name,
      allowedRepos: allowed,
      now: () => new Date(),
      runnerKind: 'docker-claude',
    });
    stages['Issue の投入（handoff）'] = '実行確認済み';
    details['Issue の投入（handoff）'] = handed.issueUrl;

    const owner = `real-run-${randomUUID().slice(0, 8)}`;
    const deadline = Date.now() + 70 * 60_000;
    const options = {
      owner,
      runner: line.runner,
      scenario: 'success' as const,
      clock: () => new Date(),
      allowedRepos: allowed,
      line,
      onlyJobId: handed.jobId,
      shutdown: stop.signal,
    };
    let view = await getJobView(handed.jobId);
    while (view && !['pr_ready', 'stopped', 'failed', 'cancelled'].includes(view.state)) {
      if (stop.signal.aborted || Date.now() > deadline) break;
      if (line.isLockHeld?.() === false) throw new Error('worker の排他を失いました');
      const outcome = await runOnce(options);
      view = await getJobView(handed.jobId);
      console.log(`[real-run] ${JSON.stringify(outcome)} 費用 ${view?.costJpy ?? '?'} 円`);
      if (outcome.kind === 'idle' || (outcome.kind === 'stepped' && outcome.to === 'unchanged')) {
        await new Promise((r) => setTimeout(r, pollMs ?? 15_000));
      }
    }

    const events = await query<{ kind: string; to_state: string | null }>(
      'select kind, to_state from job_event where job_id=$1',
      [handed.jobId],
    );
    const reached = (to: string): boolean => events.rows.some((e) => e.to_state === to);
    if (reached('implementing')) stages['計画（AI）'] = '実行確認済み';
    if (reached('verifying')) {
      stages['実装と差分検査（AI・ホスト）'] = '実行確認済み';
      stages['push と PR の作成'] = '実行確認済み';
    }
    const state = view?.workState as { pr?: { url?: string } } | undefined;
    if (state?.pr?.url) details['push と PR の作成'] = state.pr.url;
    const sources = await query<{ log_ref: string | null }>(
      `select log_ref from verification where job_id=$1 and source='github' order by run_sequence desc limit 1`,
      [handed.jobId],
    );
    if (sources.rows[0]) {
      stages['独立 CI の収集'] = '実行確認済み';
      details['独立 CI の収集'] = sources.rows[0].log_ref ?? '';
    }
    if (view?.state === 'pr_ready') {
      stages['pr_ready（人の承認待ち）'] = '実行確認済み';
      const failedBody = events.rows.some((e) => e.kind === 'pr_body_update_failed');
      stages['PR 本文の更新'] = failedBody ? '失敗' : '実行確認済み';
    }
    console.log(
      `\njob: ${handed.jobId} 状態: ${view?.state ?? '不明'} 停止理由: ${view?.stopReason ?? 'なし'} 費用: ${view?.costJpy ?? '?'} 円`,
    );
    report();
    return view?.state === 'pr_ready';
  } catch (err) {
    console.error(`[real-run] 止まりました: ${(err as Error).name}: ${(err as Error).message}`);
    report();
    return false;
  } finally {
    await closeLine?.();
    await closePool();
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const known = new Set(['--dry-run', '--confirm-real-run']);
  for (const arg of args) {
    if (!known.has(arg)) {
      console.error(`知らない引数です: ${arg}`);
      process.exitCode = 2;
      return;
    }
  }
  if (args.has('--confirm-real-run') && args.has('--dry-run')) {
    console.error('--dry-run と --confirm-real-run は同時に指定できません');
    process.exitCode = 2;
    return;
  }
  if (!args.has('--confirm-real-run')) {
    const { text, ok } = dryRunReport(process.env);
    console.log(text);
    process.exitCode = ok ? 0 : 1;
    return;
  }
  process.exitCode = (await realRun(process.env)) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
