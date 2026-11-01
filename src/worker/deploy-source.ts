/**
 * merge 済みの SHA のソースだけを取り出す。.git を残さず、イメージの文脈へ資格情報を入れない。
 * トークンは fetch の子プロセスの環境変数だけに置く（git-workspace.ts と同じ流儀）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertGitBaseUrlAllowed } from './git-workspace.js';

export interface DeploySource {
  /** 取り出した作業場の path と片付け。SHA が違えば例外。 */
  fetch(input: { repo: string; sha: string }): Promise<{ dir: string; cleanup: () => void }>;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never', ...args],
      { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('git を起動できませんでした'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 引数と出力をエラーへ載せない
      if (code === 0) resolve(out.trim());
      else reject(new Error(`git ${args[0]} に失敗しました`));
    });
  });
}

export function createDeploySource(options: { gitBaseUrl: string; token: string; nodeEnv: string }): DeploySource {
  const base = assertGitBaseUrlAllowed(options.gitBaseUrl, options.nodeEnv);
  return {
    async fetch({ repo, sha }) {
      if (!SHA_RE.test(sha) || !REPO_RE.test(repo)) throw new Error('対象の形が正しくありません');
      const dir = mkdtempSync(join(tmpdir(), 'msf-deploy-src-'));
      const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      };
      const authed: NodeJS.ProcessEnv = options.token
        ? {
            ...env,
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: `http.${base.origin}/.extraHeader`,
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${options.token}`, 'utf8').toString('base64')}`,
          }
        : env;
      try {
        await git(dir, ['init', '--quiet'], env);
        await git(dir, ['fetch', '--quiet', '--depth=1', `${base.origin}/${repo}.git`, sha], authed);
        await git(dir, ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], env);
        const head = await git(dir, ['rev-parse', 'HEAD'], env);
        if (head !== sha) throw new Error('取り出した SHA が違います');
        rmSync(join(dir, '.git'), { recursive: true, force: true });
        return { dir, cleanup };
      } catch (err) {
        cleanup();
        throw err;
      }
    },
  };
}
