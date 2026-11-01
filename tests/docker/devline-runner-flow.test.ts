/**
 * 実 Docker の引数で runner を最後まで動かす（`pnpm test:docker`）。
 * claude だけを自作の偽物に差し替えたイメージを使うので、Anthropic へは送らない。git はループバックの fake GitHub。
 * 確かめるのは --user・--read-only・--tmpfs・bind mount・timeout・隔離ネットワーク・docker kill の実物の組み合わせ。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SANDBOX_REPO } from '../../src/shared/devline.js';
import type { RunnerInput, RunnerResult } from '../../src/shared/devline.js';
import { RUNNER_IMAGE, createDockerClaudeRunner } from '../../src/worker/docker-claude-runner.js';
import { DUMMY_API_KEY, DUMMY_GH_TOKEN, startRealGithub, type RealGithub } from '../integration/devline-real-harness.js';

const image = `msf-devline-test-fake-claude:${randomBytes(4).toString('hex')}`;
const imageNoCli = `msf-devline-test-no-cli:${randomBytes(4).toString('hex')}`;
const budget = { limitJpy: 1000, jpyPerUsd: 160 };

function tryDocker(...args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}

/** 失敗したときに原因が分かる情報（隔離ネットワークの段階、stderr、Docker のネットワークの数）。 */
function why(result: RunnerResult): string {
  const networks = tryDocker('network', 'ls', '--quiet', '--filter', 'driver=bridge').split('\n').filter(Boolean).length;
  const logs = result.artifacts.map((a) => `[${a.name}] ${a.content ?? ''}`).join('\n');
  return `summary=${result.summary}\nexit=${result.exitCode}\nbridge_networks=${networks}\n${logs}`;
}

const FAKE_CLAUDE = String.raw`const fs = require('node:fs');
const http = require('node:http');
const prompt = process.argv[process.argv.indexOf('-p') + 1];
if (prompt.includes('HANGNOW')) setInterval(() => {}, 1000);
else {
  const facts = {
    uid: process.getuid(),
    home: process.env.HOME,
    hasKey: Boolean(process.env.ANTHROPIC_API_KEY),
    hasGitToken: Object.keys(process.env).some((k) => /GITHUB|TOKEN/.test(k)),
    envNames: Object.keys(process.env).filter((k) => /KEY|PROXY|CLAUDE|AUTOUPDATER/.test(k)).sort(),
    hasDotGit: fs.existsSync('/workspace/.git'),
    hasDotClaude: fs.existsSync('/workspace/.claude'),
  };
  try { fs.writeFileSync('/etc/x', 'x'); facts.rootWritable = true; } catch { facts.rootWritable = false; }
  fs.mkdirSync('/tmp/home', { recursive: true });
  fs.mkdirSync('/workspace/src', { recursive: true });
  fs.writeFileSync('/workspace/src/from-container.js', 'export const x = 1;\n');
  const proxy = new URL(process.env.HTTPS_PROXY);
  const req = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: 'github.com:443' });
  const done = (status) => {
    facts.proxyStatus = status;
    process.stdout.write(JSON.stringify({ subtype: 'success', is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 },
      structured_output: { summary: JSON.stringify(facts), needs_human: false, plan_steps: [] } }));
    process.exit(0);
  };
  req.on('connect', (res) => done(res.statusCode));
  req.on('error', () => done(0));
  req.end();
}
`;

describe('runner を実 Docker で動かす（claude は偽物）', () => {
  let gh: RealGithub;
  let root: string;

  const input = (attemptNo: number, purpose: string): RunnerInput => ({
    jobId: '22222222-2222-2222-2222-222222222222',
    attemptNo,
    step: 'implement',
    order: {
      canonicalYaml: `id: "REQ-2026-0001"\npurpose: "${purpose}"\n`,
      envelope: {
        schema: 'msf.order-envelope/v1',
        request_id: 'REQ-2026-0001',
        order_version: 1,
        content_sha256: 'a'.repeat(64),
        approval: { id: 'x', approver_user_id: 'x', decided_signal: 'g', suggested_signal: 'g', approved_at: '' },
        target_repo_id: SANDBOX_REPO.name,
        base_sha: gh.baseSha,
        policy_version: 'devline-policy/v1',
        frozen_at: '',
      },
    },
    acceptanceCriteriaIds: ['AC-1'],
    policyVersion: 'devline-policy/v1',
    baseSha: gh.baseSha,
    deadlineAt: '',
    signal: new AbortController().signal,
  });

  const makeRunner = (timeoutMs?: number, runnerImage = image) =>
    createDockerClaudeRunner({
      apiKey: DUMMY_API_KEY,
      gitToken: DUMMY_GH_TOKEN,
      gitBaseUrl: gh.gitBaseUrl,
      nodeEnv: 'test',
      budget,
      runnerImage,
      workspaceRoot: root,
      ...(timeoutMs ? { timeoutMs } : {}),
    });

  beforeAll(async () => {
    gh = await startRealGithub();
    root = mkdtempSync(join(tmpdir(), 'msf-docker-ws-'));
    const ctx = mkdtempSync(join(tmpdir(), 'msf-docker-ctx-'));
    writeFileSync(join(ctx, 'fake.cjs'), FAKE_CLAUDE);
    writeFileSync(join(ctx, 'claude'), '#!/bin/sh\nexec node /opt/fake.cjs "$@"\n', { mode: 0o755 });
    writeFileSync(
      join(ctx, 'Dockerfile'),
      `FROM ${RUNNER_IMAGE}\nCOPY fake.cjs /opt/fake.cjs\nCOPY claude /usr/local/bin/claude\n`,
    );
    execFileSync('docker', ['build', '-q', '-t', image, ctx], { stdio: 'ignore' });
    writeFileSync(join(ctx, 'Dockerfile'), `FROM ${RUNNER_IMAGE}\nUSER root\nRUN rm -f "$(command -v claude)"\n`);
    execFileSync('docker', ['build', '-q', '-t', imageNoCli, ctx], { stdio: 'ignore' });
    rmSync(ctx, { recursive: true, force: true });
  });

  afterAll(async () => {
    tryDocker('image', 'rm', image);
    tryDocker('image', 'rm', imageNoCli);
    await gh.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('作業ツリーだけが見え、書いたものをホストが差分にして push できる。片付く', async () => {
    const runner = makeRunner();
    const run = input(2, 'normal');
    const result = await runner.run(run);
    expect(result.status, why(result)).toBe('succeeded');
    expect(result.changedPaths).toEqual(['src/from-container.js']);
    expect(result.serverDiff?.violations).toEqual([]);
    expect(result.usage.costJpy).toBe(2);
    const facts = JSON.parse(result.summary) as Record<string, unknown>;
    expect(facts).toMatchObject({
      uid: process.getuid?.(),
      home: '/tmp/home',
      hasKey: true,
      hasGitToken: false,
      hasDotGit: false,
      hasDotClaude: false,
      rootWritable: false,
      proxyStatus: 403,
    });
    expect(facts.envNames).toEqual([
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
      'DISABLE_AUTOUPDATER',
      'HTTPS_PROXY',
      'HTTP_PROXY',
    ]);

    const workspace = runner.workspaceOf(run) as NonNullable<ReturnType<typeof runner.workspaceOf>>;
    await workspace.push(result.headSha as string, 'auto/req-2026-0001-v1-a2');
    expect(gh.branchTip('auto/req-2026-0001-v1-a2')).toBe(result.headSha);
    expect(gh.fileAt(result.headSha as string, 'src/from-container.js')).toContain('x = 1');
    expect(gh.fileAt(result.headSha as string, '.claude/settings.json')).not.toBeNull();
    const gitConfig = readFileSync(join(workspace.workTree, '..', 'git', 'config'), 'utf8');
    expect(gitConfig).not.toContain(DUMMY_GH_TOKEN);
    expect(gitConfig).not.toContain(Buffer.from(`x-access-token:${DUMMY_GH_TOKEN}`).toString('base64'));
    expect(gitConfig.toLowerCase()).not.toContain('extraheader');

    await runner.release?.(run);
    expect(readdirSync(root)).toEqual([]);
    expect(tryDocker('ps', '--all', '--quiet', '--filter', 'name=msf-dl-run-')).toBe('');
    expect(tryDocker('network', 'ls', '--quiet', '--filter', 'name=msf-dl-int-')).toBe('');
    expect(tryDocker('network', 'ls', '--quiet', '--filter', 'name=msf-dl-egr-')).toBe('');
  });

  it('時間切れは実物の docker kill で止まり、費用を割り当てどおりに計上する', async () => {
    const runner = makeRunner(3000);
    const run = input(3, 'HANGNOW');
    const started = Date.now();
    const result = await runner.run(run);
    // 本当に動き続けていて、時間切れで止まった
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(result.status, why(result)).toBe('failed');
    expect(result.costEstimated, why(result)).toBe(true);
    expect(result.usage.costJpy, why(result)).toBe(1000);
    await runner.release?.(run);
    expect(tryDocker('ps', '--all', '--quiet', '--filter', 'name=msf-dl-run-')).toBe('');
  });

  it('中の claude を起動できないと 0 円（実物の docker の exit code で確かめる）', async () => {
    const runner = makeRunner(undefined, imageNoCli);
    const run = input(4, 'normal');
    const result = await runner.run(run);
    expect(result.status, why(result)).toBe('failed');
    expect(result.notStarted, why(result)).toBe(true);
    expect(result.exitCode, why(result)).toBe(127);
    expect(result.usage.costJpy, why(result)).toBe(0);
    await runner.release?.(run);
    expect(tryDocker('ps', '--all', '--quiet', '--filter', 'name=msf-dl-run-')).toBe('');
  });

  it('docker run の直後の取消でも実物のコンテナを止める', async () => {
    const runner = makeRunner();
    const controller = new AbortController();
    const run: RunnerInput = { ...input(5, 'HANGNOW'), signal: controller.signal };
    const running = runner.run(run);
    // 隔離ネットワークの用意が終わって docker run を呼ぶ頃に取り消す（コンテナの作成と競合させる）
    for (let i = 0; i < 400; i += 1) {
      if (tryDocker('ps', '--quiet', '--filter', 'name=msf-dl-proxy-') !== '') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 150));
    const started = Date.now();
    controller.abort();
    const result = await running;
    expect(Date.now() - started, why(result)).toBeLessThan(30_000);
    expect(result.status, why(result)).toBe('failed');
    expect(result.exitCode, why(result)).toBe(137);
    await runner.release?.(run);
    expect(tryDocker('ps', '--all', '--quiet', '--filter', 'name=msf-dl-run-')).toBe('');
    expect(tryDocker('ps', '--all', '--quiet', '--filter', 'name=msf-dl-proxy-')).toBe('');
    expect(tryDocker('network', 'ls', '--quiet', '--filter', 'name=msf-dl-int-')).toBe('');
  });
});
