/**
 * 実 runner の試験の部品。外部は OS 割当ポートのローカルだけ。実 GitHub・Anthropic へ送らない。
 * - fake GitHub: REST API と、本物の git（git http-backend）で clone / push を受ける。
 * - stub docker: PATH の差し替えで `docker` を置きかえる。呼び出しの argv と環境を記録し、シナリオどおりに作業場を書きかえる。
 * ここは *.test.ts ではないので単独では実行されない。
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_REPO } from '../../src/shared/devline.js';

export const REAL_REPO = SANDBOX_REPO.name;
export const REAL_REPO_ID = SANDBOX_REPO.repoId;
export const REAL_LOGIN = 'msf-real-bot';
export const DUMMY_API_KEY = 'dummy-anthropic-key-not-a-secret-0123456789';
export const DUMMY_GH_TOKEN = 'dummy-github-token-not-a-secret-0123456789';

const CLEAN_GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'seed',
  GIT_AUTHOR_EMAIL: 'seed@example.invalid',
  GIT_COMMITTER_NAME: 'seed',
  GIT_COMMITTER_EMAIL: 'seed@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: CLEAN_GIT_ENV, encoding: 'utf8' }).trim();
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  state: string;
  headRef: string;
  headSha: string;
  base: string;
  login: string;
}

export interface FakeRun {
  id: number;
  run_number: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string | null;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_repository: { full_name: string };
  repository: { full_name: string };
  pull_requests: { number: number }[];
  jobs: { name: string; status: string; conclusion: string | null; head_sha: string; html_url: string }[];
}

export type RealResponder = (req: { method: string; path: string; body: any }) => {
  status: number;
  body?: unknown;
  /** 処理を進めたうえで接続を切る（応答の喪失）。 */
  destroy?: boolean;
  /** 通常の処理を実行してから destroy する。 */
  thenDestroy?: boolean;
} | null;

export interface RealGithub {
  apiUrl: string;
  gitBaseUrl: string;
  baseSha: string;
  bareDir: string;
  access: { method: string; path: string; query: string; authorization: string | undefined }[];
  gitAuth: (string | undefined)[];
  gitOps: string[];
  pulls: FakePull[];
  runs: FakeRun[];
  issues: { number: number; title: string; body: string; login: string }[];
  responders: RealResponder[];
  repoPrivate: boolean;
  repoId: string;
  autoRun: boolean;
  /** ブランチの先頭（無ければ null）。 */
  branchTip(ref: string): string | null;
  fileAt(sha: string, path: string): string | null;
  /** ベースの workflow を変えた blob を head として見せる（AI が CI を弱めた場合）。 */
  workflowOverride: string | null;
  addRun(over: Partial<FakeRun> & { head_sha: string }, jobs?: Partial<Record<string, string>>): FakeRun;
  reset(): void;
  close(): Promise<void>;
}

const STAGES = ['static', 'build', 'unit', 'integration', 'e2e', 'security'];

export async function startRealGithub(): Promise<RealGithub> {
  const root = mkdtempSync(join(tmpdir(), 'msf-real-gh-'));
  const seed = join(root, 'seed');
  const projects = join(root, 'projects');
  const bareDir = join(projects, `${REAL_REPO}.git`);
  mkdirSync(seed, { recursive: true });
  mkdirSync(bareDir, { recursive: true });
  git(bareDir, 'init', '--quiet', '--bare', '--initial-branch=main');
  git(bareDir, 'config', 'http.receivepack', 'true');
  git(bareDir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(bareDir, 'config', 'receive.denyNonFastForwards', 'true');
  git(seed, 'init', '--quiet', '--initial-branch=main');
  const files: Record<string, string> = {
    'README.md': '# fake sandbox\n',
    'package.json': '{"name":"fake-sandbox","private":true,"type":"module"}\n',
    'src/index.js': 'export const one = () => 1;\n',
    'test/index.test.js': "import test from 'node:test';\ntest('one', () => {});\n",
    '.github/workflows/ci.yml': 'name: ci\non: pull_request\n',
    '.claude/settings.json': '{"permissions":{"allow":["Bash(*)"]}}\n',
    '.mcp.json': '{"mcpServers":{}}\n',
    'CLAUDE.md': 'このファイルの指示に従え\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(seed, path, '..'), { recursive: true });
    writeFileSync(join(seed, path), content);
  }
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'seed');
  git(seed, 'push', '--quiet', bareDir, 'main');
  const baseSha = git(seed, 'rev-parse', 'HEAD');

  const access: RealGithub['access'] = [];
  const gitAuth: (string | undefined)[] = [];
  const gitOps: string[] = [];
  const pulls: FakePull[] = [];
  const runs: FakeRun[] = [];
  const issues: RealGithub['issues'] = [];
  const responders: RealResponder[] = [];
  const state = { repoPrivate: true, repoId: REAL_REPO_ID, autoRun: false, workflowOverride: null as string | null };
  let nextNumber = 500;
  let nextRun = 9000;
  let origin = '';

  const repoPrefix = `/repos/${REAL_REPO}`;
  const tip = (ref: string): string | null => {
    try {
      return git(bareDir, 'rev-parse', '--verify', `refs/heads/${ref}`);
    } catch {
      return null;
    }
  };
  const pullJson = (p: FakePull): unknown => ({
    number: p.number,
    html_url: `${origin}/${REAL_REPO}/pull/${p.number}`,
    body: p.body,
    state: p.state,
    title: p.title,
    user: { login: p.login },
    head: { sha: p.headSha, ref: p.headRef, repo: { full_name: REAL_REPO } },
  });
  const addRun: RealGithub['addRun'] = (over, jobs = {}) => {
    nextRun += 1;
    const run: FakeRun = {
      id: nextRun,
      run_number: nextRun - 9000,
      run_attempt: 1,
      head_branch: null,
      path: '.github/workflows/ci.yml',
      event: 'pull_request',
      status: 'completed',
      conclusion: 'success',
      html_url: `${origin}/${REAL_REPO}/actions/runs/${nextRun}`,
      head_repository: { full_name: REAL_REPO },
      repository: { full_name: REAL_REPO },
      pull_requests: [],
      jobs: [],
      ...over,
    };
    run.jobs = STAGES.filter((s) => jobs[s] !== 'missing').map((name) => {
      const conclusion = jobs[name] ?? 'success';
      return {
        name,
        status: 'completed',
        conclusion,
        head_sha: over.head_sha,
        html_url: `${origin}/${REAL_REPO}/actions/runs/${nextRun}/job/${name}`,
      };
    });
    runs.push(run);
    return run;
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const handleGit = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    gitAuth.push(req.headers.authorization);
    gitOps.push(`${req.method} ${url.pathname}${url.search}`);
    const child = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GIT_PROJECT_ROOT: projects,
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        PATH_INFO: url.pathname,
        REQUEST_METHOD: req.method ?? 'GET',
        QUERY_STRING: url.search.replace(/^\?/, ''),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
        REMOTE_USER: 'fake',
        REMOTE_ADDR: '127.0.0.1',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    req.pipe(child.stdin);
    let buffered = Buffer.alloc(0);
    let wroteHead = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (wroteHead) {
        res.write(chunk);
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const split = buffered.indexOf('\r\n\r\n');
      if (split < 0) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of buffered.subarray(0, split).toString('utf8').split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === 'status') status = Number(value.split(' ')[0]);
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      wroteHead = true;
      res.write(buffered.subarray(split + 4));
    });
    child.on('close', () => {
      if (!wroteHead) res.writeHead(500);
      res.end();
    });
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? (JSON.parse(text) as any) : null;
    access.push({ method, path, query: url.search, authorization: req.headers.authorization });

    const responder = responders.shift();
    const reply = responder ? responder({ method, path, body }) : null;
    if (responder && !reply) responders.unshift(responder);
    if (reply?.destroy) {
      res.destroy();
      return;
    }
    if (reply && !reply.thenDestroy) return send(res, reply.status, reply.body ?? {});
    const finish = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
      if (reply?.thenDestroy) res.destroy();
      else send(res, status, payload, headers);
    };

    if (method === 'GET' && path === '/user') return finish(200, { login: REAL_LOGIN });
    if (method === 'GET' && path === repoPrefix) {
      return finish(200, { id: Number(state.repoId), default_branch: 'main', private: state.repoPrivate });
    }
    if (method === 'GET' && path === `${repoPrefix}/commits/main`) return finish(200, { sha: baseSha });

    if (method === 'POST' && path === `${repoPrefix}/issues`) {
      nextNumber += 1;
      const issue = { number: nextNumber, title: body.title, body: body.body, login: REAL_LOGIN };
      issues.push(issue);
      return finish(201, {
        number: issue.number,
        html_url: `${origin}/${REAL_REPO}/issues/${issue.number}`,
        body: issue.body,
        user: { login: REAL_LOGIN },
      });
    }
    const single = new RegExp(`^${repoPrefix}/issues/(\\d+)$`).exec(path);
    if (method === 'GET' && single) {
      const number = Number(single[1]);
      const pull = pulls.find((p) => p.number === number);
      if (pull) {
        return finish(200, {
          number,
          html_url: `${origin}/${REAL_REPO}/pull/${number}`,
          body: pull.body,
          user: { login: pull.login },
          pull_request: {},
        });
      }
      const issue = issues.find((i) => i.number === number);
      if (!issue) return finish(404, { message: 'Not Found' });
      return finish(200, {
        number,
        html_url: `${origin}/${REAL_REPO}/issues/${number}`,
        body: issue.body,
        user: { login: issue.login },
      });
    }

    if (method === 'POST' && path === `${repoPrefix}/pulls`) {
      const headSha = tip(body.head);
      if (!headSha) return finish(422, { message: 'Validation Failed', errors: [{ message: 'no head' }] });
      if (pulls.some((p) => p.headRef === body.head && p.state === 'open')) {
        return finish(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] });
      }
      nextNumber += 1;
      const pull: FakePull = {
        number: nextNumber,
        title: body.title,
        body: body.body,
        state: 'open',
        headRef: body.head,
        headSha,
        base: body.base,
        login: REAL_LOGIN,
      };
      pulls.push(pull);
      if (state.autoRun) addRun({ head_sha: headSha, head_branch: body.head, pull_requests: [{ number: pull.number }] });
      return finish(201, pullJson(pull));
    }
    if (method === 'GET' && path === `${repoPrefix}/pulls`) {
      const head = url.searchParams.get('head') ?? '';
      const ref = head.split(':')[1] ?? '';
      return finish(200, pulls.filter((p) => !ref || p.headRef === ref).map(pullJson));
    }
    const pullOne = new RegExp(`^${repoPrefix}/pulls/(\\d+)$`).exec(path);
    if (method === 'PATCH' && pullOne) {
      const pull = pulls.find((p) => p.number === Number(pullOne[1]));
      if (!pull) return finish(404, { message: 'Not Found' });
      if (typeof body.body === 'string') pull.body = body.body;
      if (typeof body.state === 'string') pull.state = body.state;
      return finish(200, pullJson(pull));
    }

    if (method === 'GET' && path === `${repoPrefix}/actions/runs`) {
      const sha = url.searchParams.get('head_sha');
      return finish(200, {
        workflow_runs: runs
          .filter((r) => !sha || r.head_sha === sha || r.event === 'stale-listed')
          .map(({ jobs: _jobs, ...r }) => r),
      });
    }
    const jobsPath = new RegExp(`^${repoPrefix}/actions/runs/(\\d+)/attempts/(\\d+)/jobs$`).exec(path);
    if (method === 'GET' && jobsPath) {
      const run = runs.find((r) => r.id === Number(jobsPath[1]) && r.run_attempt === Number(jobsPath[2]));
      return run ? finish(200, { jobs: run.jobs }) : finish(404, { message: 'Not Found' });
    }
    if (method === 'GET' && path === `${repoPrefix}/contents/.github/workflows/ci.yml`) {
      const ref = url.searchParams.get('ref') ?? '';
      if (state.workflowOverride !== null && ref !== baseSha) {
        return finish(200, { type: 'file', sha: state.workflowOverride });
      }
      try {
        return finish(200, { type: 'file', sha: git(bareDir, 'rev-parse', `${ref}:.github/workflows/ci.yml`) });
      } catch {
        return finish(404, { message: 'Not Found' });
      }
    }
    return finish(404, { message: 'Not Found' });
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname.startsWith(`/${REAL_REPO}.git/`)) {
      handleGit(req, res, url);
      return;
    }
    handleApi(req, res, url).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    apiUrl: origin,
    gitBaseUrl: origin,
    baseSha,
    bareDir,
    access,
    gitAuth,
    gitOps,
    pulls,
    runs,
    issues,
    responders,
    get repoPrivate() {
      return state.repoPrivate;
    },
    set repoPrivate(v) {
      state.repoPrivate = v;
    },
    get repoId() {
      return state.repoId;
    },
    set repoId(v) {
      state.repoId = v;
    },
    get autoRun() {
      return state.autoRun;
    },
    set autoRun(v) {
      state.autoRun = v;
    },
    get workflowOverride() {
      return state.workflowOverride;
    },
    set workflowOverride(v) {
      state.workflowOverride = v;
    },
    branchTip: tip,
    fileAt(sha, path) {
      try {
        return git(bareDir, 'show', `${sha}:${path}`);
      } catch {
        return null;
      }
    },
    addRun,
    reset() {
      // 依頼番号は試験ごとに戻るので、ブランチも戻す
      const refs = git(bareDir, 'for-each-ref', '--format=%(refname)', 'refs/heads/auto').split('\n').filter(Boolean);
      for (const ref of refs) git(bareDir, 'update-ref', '-d', ref);
      access.length = 0;
      gitAuth.length = 0;
      gitOps.length = 0;
      pulls.length = 0;
      runs.length = 0;
      issues.length = 0;
      responders.length = 0;
      state.repoPrivate = true;
      state.repoId = REAL_REPO_ID;
      state.autoRun = false;
      state.workflowOverride = null;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => {
          rmSync(root, { recursive: true, force: true });
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

/* ──────────────── stub docker ──────────────── */

export interface StubStep {
  /** 作業ツリーへ書くファイル。 */
  files?: Record<string, string>;
  symlinks?: Record<string, string>;
  delete?: string[];
  rename?: [string, string][];
  /** サブディレクトリに本物の .git を置く（submodule を作ろうとする）。 */
  nestedGit?: string;
  /** 作業ツリーの .git を作る。 */
  dotGit?: boolean;
  /** docker kill されるまで終わらない。 */
  hang?: boolean;
  /** CLI の JSON の上書き（既定は success）。raw があればそのまま出す。 */
  output?: Record<string, unknown>;
  raw?: string;
  exit?: number;
}

export interface StubScenario {
  plan?: StubStep;
  implement?: StubStep;
  revise?: StubStep;
  /** docker image inspect を失敗させる。 */
  noImages?: boolean;
  /** 隔離ネットワークの作成を失敗させる。 */
  networkFails?: boolean;
}

export interface StubCall {
  argv: string[];
  env: Record<string, string>;
}

const STUB_SOURCE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv, env: process.env }) + '\n');
const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
const [cmd, sub] = argv;
const done = (code = 0, text = '') => { if (text) process.stdout.write(text); process.exit(code); };

if (cmd === 'image') done(scenario.noImages ? 1 : 0, 'sha256:stub\n');
if (cmd === 'network') {
  if (sub === 'create' && scenario.networkFails) done(1);
  done(0, sub === 'ls' ? '' : 'id\n');
}
if (cmd === 'ps') done(0, '');
if (cmd === 'logs') done(0, 'egress-proxy listening\n');
if (cmd === 'kill') {
  const name = argv[1];
  const pidFile = path.join(dir, 'hang-' + name + '.pid');
  if (fs.existsSync(pidFile)) {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
    fs.rmSync(pidFile);
    done(0);
  }
  done(1);
}
if (cmd !== 'run') done(1);
if (argv.includes('--detach')) done(0, 'proxy-id\n');

const name = argv[argv.indexOf('--name') + 1];
const mount = argv[argv.indexOf('--mount') + 1];
const work = /src=([^,]+)/.exec(mount)[1];
const promptIndex = argv.indexOf('-p') + 1;
const prompt = argv[promptIndex];
fs.writeFileSync(path.join(dir, 'prompt-' + name + '.txt'), prompt);
const stepName = prompt.includes('今回の工程は計画') ? 'plan' : prompt.includes('今回の工程は修正') ? 'revise' : 'implement';
const step = scenario[stepName] || {};
fs.appendFileSync(path.join(dir, 'steps.jsonl'), JSON.stringify({ step: stepName, name, listing: fs.readdirSync(work), hasGit: fs.existsSync(path.join(work, '.git')), hasClaude: fs.existsSync(path.join(work, '.claude')), hasMcp: fs.existsSync(path.join(work, '.mcp.json')), hasClaudeMd: fs.existsSync(path.join(work, 'CLAUDE.md')), previous: fs.existsSync(path.join(work, 'src/feature.js')) }) + '\n');

for (const [p, content] of Object.entries(step.files || {})) {
  fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true });
  fs.writeFileSync(path.join(work, p), content);
}
for (const [p, target] of Object.entries(step.symlinks || {})) {
  fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true });
  fs.symlinkSync(target, path.join(work, p));
}
for (const p of step.delete || []) fs.rmSync(path.join(work, p), { recursive: true, force: true });
for (const [a, b] of step.rename || []) {
  fs.mkdirSync(path.dirname(path.join(work, b)), { recursive: true });
  fs.renameSync(path.join(work, a), path.join(work, b));
}
if (step.dotGit) fs.writeFileSync(path.join(work, '.git'), 'gitdir: /etc\n');
if (step.nestedGit) {
  const nested = path.join(work, step.nestedGit);
  fs.mkdirSync(nested, { recursive: true });
  const { execFileSync } = require('node:child_process');
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@example.invalid', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@example.invalid' };
  execFileSync('git', ['init', '--quiet'], { cwd: nested, env });
  fs.writeFileSync(path.join(nested, 'a.txt'), 'a');
  execFileSync('git', ['add', '.'], { cwd: nested, env });
  execFileSync('git', ['commit', '--quiet', '-m', 'x'], { cwd: nested, env });
}
if (step.hang) {
  fs.writeFileSync(path.join(dir, 'hang-' + name + '.pid'), String(process.pid));
  setInterval(() => {}, 1000);
} else {
  if (step.raw !== undefined) process.stdout.write(step.raw);
  else process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'done',
    structured_output: { summary: 'stub ' + stepName, needs_human: false, plan_steps: ['stub'] },
    session_id: 'stub-session', total_cost_usd: 0.1,
    usage: { input_tokens: 10, output_tokens: 5, future_field: 1 }, num_turns: 2, duration_ms: 1000, permission_denials: [],
    unknown_future: true, ...(step.output || {}),
  }));
  process.exit(step.exit || 0);
}
`;

export interface StubDocker {
  dir: string;
  setScenario(scenario: StubScenario): void;
  calls(): StubCall[];
  steps(): {
    step: string;
    name: string;
    hasGit: boolean;
    hasClaude: boolean;
    hasMcp: boolean;
    hasClaudeMd: boolean;
    previous: boolean;
  }[];
  prompts(): string[];
  reset(): void;
  remove(): void;
}

/** stub を置き、PATH の先頭へ入れる。remove で元に戻す。 */
export function installStubDocker(): StubDocker {
  const dir = mkdtempSync(join(tmpdir(), 'msf-stub-docker-'));
  const stub = join(dir, 'docker');
  writeFileSync(stub, STUB_SOURCE);
  chmodSync(stub, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath ?? ''}`;
  const scenarioPath = join(dir, 'scenario.json');
  const readLines = (name: string): any[] => {
    try {
      return readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  writeFileSync(scenarioPath, '{}');
  return {
    dir,
    setScenario: (scenario) => writeFileSync(scenarioPath, JSON.stringify(scenario)),
    calls: () => readLines('calls.jsonl'),
    steps: () => readLines('steps.jsonl'),
    prompts() {
      return readLines('steps.jsonl').map((s: { name: string }) => readFileSync(join(dir, `prompt-${s.name}.txt`), 'utf8'));
    },
    reset() {
      rmSync(join(dir, 'calls.jsonl'), { force: true });
      rmSync(join(dir, 'steps.jsonl'), { force: true });
      writeFileSync(scenarioPath, '{}');
    },
    remove() {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 試験用の資格情報ファイル（本物の path を使わない）。 */
export function writeSecretsFile(dir: string, mode = 0o600, content?: string): string {
  const path = join(dir, 'devline-secrets.env');
  writeFileSync(path, content ?? `ANTHROPIC_API_KEY=${DUMMY_API_KEY}\nDEVLINE_GITHUB_TOKEN=${DUMMY_GH_TOKEN}\nOTHER=ignored\n`, {
    mode,
  });
  chmodSync(path, mode);
  return path;
}
