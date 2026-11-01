/**
 * 検証環境（このホストのローカル Docker）の操作。AI コンテナは関与しない。
 * 触るのはラベル msf.devline.deploy=1 のコンテナとイメージだけ。他のプロジェクトのものへは命令を出さない。
 * 名前のコンテナがあってもラベルが無ければ消さず、失敗にする。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { DEPLOY_LABEL, healthMatches, smokeMatches } from '../shared/devline-release.js';

export interface DeployRunSpec {
  name: string;
  digest: string;
  port: number;
  version: string;
}

export interface DeployDocker {
  /** イメージを作り、digest を返す（sha256:...）。 */
  build(input: { contextDir: string; tag: string; sha: string }): Promise<string>;
  hasImage(digest: string): Promise<boolean>;
  /** ラベル付きのコンテナがあるか。名前があってラベルが無ければ 'foreign'。 */
  containerState(name: string): Promise<'none' | 'own' | 'foreign'>;
  run(spec: DeployRunSpec): Promise<void>;
  /** ラベル付きのコンテナを止めて消す。無ければ何もしない。 */
  remove(name: string): Promise<void>;
  portFree(port: number): Promise<boolean>;
}

export interface DeployProbe {
  /** health（/healthz の version が sha）と smoke（/length?text=abc が 3）。 */
  check(port: number, sha: string): Promise<{ health: boolean; smoke: boolean }>;
}

export class DockerCommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'DockerCommandError';
  }
}

function docker(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // 子へ渡す環境は最小限。資格情報を渡さない
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' };
    if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      if (out.length < 64_000) out += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 8_000) err += c.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new DockerCommandError(e.name, null));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new DockerCommandError(`docker ${args[0]} exited ${String(code)}: ${err.slice(0, 300)}`, code));
    });
  });
}

const BUILD_TIMEOUT_MS = 600_000;
const COMMAND_TIMEOUT_MS = 60_000;

export function createDeployDocker(): DeployDocker {
  return {
    async build({ contextDir, tag, sha }) {
      await docker(
        ['build', '--label', DEPLOY_LABEL, '--label', `msf.devline.sha=${sha}`, '-t', tag, contextDir],
        BUILD_TIMEOUT_MS,
      );
      const id = await docker(['image', 'inspect', '--format', '{{.Id}}', tag], COMMAND_TIMEOUT_MS);
      if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new DockerCommandError('digest を読めませんでした', null);
      return id;
    },

    async hasImage(digest) {
      try {
        const label = await docker(
          ['image', 'inspect', '--format', '{{index .Config.Labels "msf.devline.deploy"}}', digest],
          COMMAND_TIMEOUT_MS,
        );
        return label === '1';
      } catch {
        return false;
      }
    },

    async containerState(name) {
      const listed = await docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], COMMAND_TIMEOUT_MS);
      if (listed.trim() === '') return 'none';
      const own = await docker(
        ['ps', '-a', '--filter', `name=^/${name}$`, '--filter', `label=${DEPLOY_LABEL}`, '--format', '{{.Names}}'],
        COMMAND_TIMEOUT_MS,
      );
      return own.trim() === '' ? 'foreign' : 'own';
    },

    async run({ name, digest, port, version }) {
      await docker(
        [
          'run',
          '-d',
          '--name',
          name,
          '--label',
          DEPLOY_LABEL,
          '-p',
          `127.0.0.1:${port}:8080`,
          '--read-only',
          '--tmpfs',
          '/tmp',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--memory',
          '256m',
          '--pids-limit',
          '128',
          '-e',
          `APP_VERSION=${version}`,
          digest,
        ],
        COMMAND_TIMEOUT_MS,
      );
    },

    async remove(name) {
      const state = await this.containerState(name);
      if (state === 'foreign') throw new DockerCommandError('同じ名前の別のコンテナがあります', null);
      if (state === 'none') return;
      await docker(['rm', '-f', name], COMMAND_TIMEOUT_MS);
    },

    portFree(port) {
      return new Promise((resolve) => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
      });
    },
  };
}

/** 起動を待って確かめる。待ち時間の上限まで繰り返す。 */
export function createDeployProbe(options: { attempts?: number; intervalMs?: number; timeoutMs?: number } = {}): DeployProbe {
  const attempts = options.attempts ?? 30;
  const intervalMs = options.intervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 3000;
  const signal = (): AbortSignal => AbortSignal.timeout(timeoutMs);
  return {
    async check(port, sha) {
      const base = `http://127.0.0.1:${port}`;
      let health = false;
      for (let i = 0; i < attempts && !health; i += 1) {
        if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
        try {
          const res = await fetch(`${base}/healthz`, { signal: signal(), redirect: 'manual' });
          health = res.ok && healthMatches(await res.json(), sha);
        } catch {
          health = false;
        }
      }
      if (!health) return { health: false, smoke: false };
      try {
        const res = await fetch(`${base}/length?text=abc`, { signal: signal(), redirect: 'manual' });
        return { health, smoke: res.ok && smokeMatches(await res.text()) };
      } catch {
        return { health, smoke: false };
      }
    },
  };
}
