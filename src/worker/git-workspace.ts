/**
 * ホスト側の作業場。job の試行ごとに一時ディレクトリへ base SHA を取り出し、終わったら消す。
 *
 * - gitdir は作業ツリーの外に置き、コンテナへは作業ツリーだけを渡す（AI が hooks や config を書けないように）。
 * - トークンは `.git/config` にも argv にも残さない。fetch / push の子プロセスの環境変数（GIT_CONFIG_*）だけに置く。
 * - git の子プロセスの環境は空から組み立てる。ホストの gh の認証や設定を読まない。
 * - push は main へしない。force しない。ブランチ名は `auto/<REQ番号小文字>-v<版>-a<試行>` のみ。
 */
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, mkdir, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JOB_BRANCH_RE, RUNNER_CONFIG_PATTERNS, normalizeRepoPath } from '../shared/devline.js';
import type { DiffViolation, RepoDiffPolicy } from '../shared/devline.js';
import { evaluateDiff, isRunnerConfigPath, parseRawDiff, type DiffEvaluation } from './diff-policy.js';

const GIT_TIMEOUT_MS = 120_000;
const MAX_WORKSPACE_BYTES = 200 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const COMMIT_IDENTITY = { name: 'mirai-sf-devline', email: 'devline@mirai-sf.invalid' };

export interface GitWorkspaceOptions {
  /** 例 `https://github.com`。試験はループバックだけ。 */
  gitBaseUrl: string;
  repo: string;
  token: string;
  nodeEnv: string;
  /** 一時ディレクトリの親。既定は OS の一時領域。 */
  rootDir?: string;
}

export class GitWorkspaceError extends Error {
  constructor(
    message: string,
    readonly cause_: 'git_failed' | 'push_rejected' | 'bad_input',
  ) {
    super(message);
    this.name = 'GitWorkspaceError';
  }
}

/** 試験ではループバックへだけ送る。それ以外も https のみ（issue-adapter と同じ流儀）。 */
export function assertGitBaseUrlAllowed(gitBaseUrl: string, nodeEnv: string): URL {
  const url = new URL(gitBaseUrl);
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (nodeEnv === 'test' && !loopback) throw new GitWorkspaceError('試験ではローカルの git だけを使えます', 'bad_input');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new GitWorkspaceError('git の接続先は https のみ使えます', 'bad_input');
  }
  if (url.username || url.password) throw new GitWorkspaceError('git の接続先に認証情報を含めないでください', 'bad_input');
  return url;
}

/** http.extraHeader の値。argv や config に置かず、環境変数だけで渡す。 */
function authEnv(baseUrl: URL, token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${baseUrl.origin}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** どの git コマンドにも付ける設定。作業ツリーの中身から何も実行させない。 */
const SAFE_GIT_ARGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.excludesFile=/dev/null',
  '-c',
  'core.pager=cat',
  '-c',
  'core.quotePath=false',
  '-c',
  'credential.helper=',
  '-c',
  'http.followRedirects=false',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'gc.auto=0',
  '-c',
  'commit.gpgSign=false',
];

interface GitRun {
  stdout: string;
  stderr: string;
}

export class GitWorkspace {
  /** コンテナへ bind mount してよいのはここだけ。 */
  readonly workTree: string;
  private readonly gitDir: string;
  private readonly home: string;
  private readonly baseUrl: URL;
  /** clone の後に作業場から除いたランナー設定。 */
  private strippedPaths: string[] = [];
  private checkedOutBase = '';

  private constructor(
    private readonly root: string,
    private readonly options: GitWorkspaceOptions,
  ) {
    this.workTree = join(root, 'work');
    this.gitDir = join(root, 'git');
    this.home = join(root, 'home');
    this.baseUrl = assertGitBaseUrlAllowed(options.gitBaseUrl, options.nodeEnv);
  }

  static async create(options: GitWorkspaceOptions): Promise<GitWorkspace> {
    assertGitBaseUrlAllowed(options.gitBaseUrl, options.nodeEnv);
    const root = await mkdtemp(join(options.rootDir ?? tmpdir(), 'msf-devline-ws-'));
    await chmod(root, 0o700);
    const workspace = new GitWorkspace(root, options);
    await mkdir(workspace.workTree, { mode: 0o700 });
    await mkdir(workspace.home, { mode: 0o700 });
    return workspace;
  }

  private remoteUrl(): string {
    return `${this.baseUrl.origin}/${this.options.repo}.git`;
  }

  /** git の子プロセスの環境。空から作る。token は network: true のときだけ。 */
  private env(network: boolean, extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: this.home,
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.workTree,
      ...(network ? authEnv(this.baseUrl, this.options.token) : {}),
      ...extra,
    };
  }

  private run(args: readonly string[], opts: { network?: boolean; env?: Record<string, string> } = {}): Promise<GitRun> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', [...SAFE_GIT_ARGS, ...args], {
        cwd: this.workTree,
        env: this.env(opts.network === true, opts.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new GitWorkspaceError(`git を起動できません（${e.name}）`, 'git_failed'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        if (code === 0) resolve({ stdout, stderr });
        // stderr は URL や要求の情報を含みうるので、メッセージに載せない
        else reject(new GitWorkspaceError(`git ${args[0] ?? ''} が失敗しました（exit ${code ?? 'signal'}）`, 'git_failed'));
      });
    });
  }

  /** base を取り出す。revise のときは startFrom（直前の head）から始める。ランナー設定は作業場から除く。 */
  async checkout(input: { baseSha: string; startFrom?: { sha: string; branch: string } | null }): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(input.baseSha)) throw new GitWorkspaceError('base SHA の形が正しくありません', 'bad_input');
    await this.run(['init', '--quiet']);
    await this.run(['fetch', '--quiet', '--no-tags', this.remoteUrl(), input.baseSha], { network: true });
    let start = input.baseSha;
    if (input.startFrom) {
      if (!JOB_BRANCH_RE.test(input.startFrom.branch)) throw new GitWorkspaceError('ブランチ名が正しくありません', 'bad_input');
      await this.run(['fetch', '--quiet', '--no-tags', this.remoteUrl(), `refs/heads/${input.startFrom.branch}`], {
        network: true,
      });
      const tip = (await this.run(['rev-parse', 'FETCH_HEAD^{commit}'])).stdout.trim();
      if (tip !== input.startFrom.sha) throw new GitWorkspaceError('直前のブランチの先頭が記録と一致しません', 'bad_input');
      start = tip;
    }
    await this.run(['checkout', '--quiet', '--force', '--detach', start]);
    this.checkedOutBase = input.baseSha;
    await this.stripRunnerConfig();
  }

  /** `.claude/` `.mcp.json` `CLAUDE.md` をランナーから見えなくする。差分の計算では無かったことにする。 */
  private async stripRunnerConfig(): Promise<void> {
    const listed = (await this.run(['ls-files', '-z'])).stdout.split('\0').filter((p) => p !== '');
    this.strippedPaths = listed.filter((p) => isRunnerConfigPath(p, RUNNER_CONFIG_PATTERNS));
    for (const path of this.strippedPaths) {
      const safe = normalizeRepoPath(path);
      if (safe === null) throw new GitWorkspaceError('リポジトリの path が読めません', 'bad_input');
      await unlink(join(this.workTree, safe));
      // 空になったディレクトリ（`.claude/` など）も見せない
      for (let dir = dirname(safe); dir !== '.'; dir = dirname(dir)) {
        try {
          await rmdir(join(this.workTree, dir));
        } catch {
          break;
        }
      }
    }
  }

  /** 除いたファイル（試験と記録のため）。 */
  strippedConfig(): readonly string[] {
    return this.strippedPaths;
  }

  /**
   * AI の作業の後、作業ツリーの実物から差分を算出して判定する。自己申告は使わない。
   * index へ載せるだけで commit はしない。コンテナが止まったことを呼び出し側が確かめてから呼ぶ。
   */
  async inspect(policy: RepoDiffPolicy): Promise<DiffEvaluation> {
    const pre: DiffViolation[] = [];
    if (await exists(join(this.workTree, '.git'))) pre.push({ path: '.git', rule: 'git_dir_in_worktree' });
    if ((await treeSize(this.workTree, MAX_WORKSPACE_BYTES)) > MAX_WORKSPACE_BYTES) {
      pre.push({ path: '.', rule: 'workspace_too_large' });
    }
    if (pre.some((v) => v.rule === 'workspace_too_large')) {
      return { policyVersion: policy.version, violations: pre, humanApproval: [], changedPaths: [] };
    }
    await this.run(['add', '--all', '--', '.']);
    // 除いたランナー設定の「削除」は AI の変更ではないので base に戻す。作り直したものは差分に残って拒否される
    if (this.strippedPaths.length > 0) {
      const raw = parseRawDiff(
        (await this.run(['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', 'HEAD'])).stdout,
      );
      const deleted = raw.filter((e) => e.status === 'D' && this.strippedPaths.includes(e.path)).map((e) => e.path);
      if (deleted.length > 0) await this.run(['reset', '--quiet', 'HEAD', '--', ...deleted]);
    }
    const raw = await this.run(['diff', '--cached', '--raw', '-z', '--no-abbrev', '-M', this.checkedOutBase]);
    const evaluation = evaluateDiff(parseRawDiff(raw.stdout), policy);
    return { ...evaluation, violations: [...pre, ...evaluation.violations] };
  }

  /** index の内容を commit する（inspect の後、違反が無いときだけ）。変更が無ければ null。 */
  async commit(message: string): Promise<string | null> {
    const changed = await this.run(['diff', '--cached', '--name-only', '-z', 'HEAD']);
    if (changed.stdout === '') return null;
    await this.run(['commit', '--quiet', '--no-verify', '-m', message], {
      env: {
        GIT_AUTHOR_NAME: COMMIT_IDENTITY.name,
        GIT_AUTHOR_EMAIL: COMMIT_IDENTITY.email,
        GIT_COMMITTER_NAME: COMMIT_IDENTITY.name,
        GIT_COMMITTER_EMAIL: COMMIT_IDENTITY.email,
      },
    });
    return (await this.run(['rev-parse', 'HEAD'])).stdout.trim();
  }

  /** ブランチへ push する。force なし。ブランチの形を確かめ、main へは送らない。 */
  async push(headSha: string, branch: string): Promise<void> {
    if (!JOB_BRANCH_RE.test(branch)) throw new GitWorkspaceError('push できないブランチ名です', 'bad_input');
    if (!/^[0-9a-f]{40}$/.test(headSha)) throw new GitWorkspaceError('head SHA の形が正しくありません', 'bad_input');
    try {
      await this.run(['push', '--quiet', '--no-verify', this.remoteUrl(), `${headSha}:refs/heads/${branch}`], { network: true });
    } catch (err) {
      if (err instanceof GitWorkspaceError) throw new GitWorkspaceError('push が拒否されました', 'push_rejected');
      throw err;
    }
  }

  /** 冪等。AI が権限を落としたディレクトリがあっても消す。 */
  async dispose(): Promise<void> {
    try {
      await rm(this.root, { recursive: true, force: true });
    } catch {
      await makeRemovable(this.root);
      await rm(this.root, { recursive: true, force: true });
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** symlink をたどらずに大きさを足す。上限を超えたら途中で返す。 */
async function treeSize(dir: string, limit: number): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0 && total <= limit) {
    const current = stack.pop() as string;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) total += (await lstat(path)).size;
    }
  }
  return total;
}

async function makeRemovable(dir: string): Promise<void> {
  await chmod(dir, 0o700).catch(() => undefined);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) await makeRemovable(join(dir, entry.name));
  }
}
