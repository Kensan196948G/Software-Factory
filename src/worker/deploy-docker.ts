/**
 * 検証環境（このホストのローカル Docker）の操作。AI コンテナは関与しない。
 * イメージを作る口は持たない。CI が残した成果物を読み込むだけ（docker build を呼ばない）。
 * 触るのはラベル msf.devline.deploy=1 のコンテナとネットワーク、自分の名前空間のタグのイメージだけ。
 * イメージにラベルは足せない（足すと ID が変わる）。自分のものかはタグ（DEPLOY_IMAGE_REPO:）で見分ける。
 * 名前のコンテナがあってもラベルが無ければ消さず、失敗にする。
 */
import { spawn } from 'node:child_process';
import {
  DEPLOY_CONTAINER_PORT,
  DEPLOY_LABEL,
  DEPLOY_NETWORK_NAME,
  healthMatches,
  smokeMatches,
} from '../shared/devline-release.js';

/** 読み込んだイメージを残すときのタグの名前空間。 */
export const DEPLOY_IMAGE_REPO = 'msf-sandbox-verify';

export interface DeployRunSpec {
  name: string;
  digest: string;
  version: string;
}

export interface DeployDocker {
  /** docker load。読み込まれた ref（タグか ID）と、その ref を inspect した ID を返す。 */
  loadImage(tarPath: string): Promise<{ ref: string; id: string }>;
  /** 照合に通ったイメージへ自分のタグを付け、読み込み時のタグを外す。 */
  adoptImage(input: { ref: string; id: string; tag: string }): Promise<void>;
  /** 照合に落ちたイメージのタグを外す（ref が自分の読み込んだものに限る）。 */
  discardImage(ref: string): Promise<void>;
  hasImage(digest: string): Promise<boolean>;
  /** ラベル付きのコンテナがあるか。名前があってラベルが無ければ 'foreign'。 */
  containerState(name: string): Promise<'none' | 'own' | 'foreign'>;
  /** 内部ネットワークで起動し、host から届く URL を返す。ポートは公開しない。 */
  run(spec: DeployRunSpec): Promise<{ baseUrl: string }>;
  /** ラベル付きのコンテナを止めて消す。無ければ何もしない。 */
  remove(name: string): Promise<void>;
}

export interface DeployProbe {
  /** health（/healthz の version が sha）と smoke（/length?text=abc が 3）。 */
  check(baseUrl: string, sha: string): Promise<{ health: boolean; smoke: boolean }>;
}

/**
 * 起動の引数（純関数。試験で固定する）。host mount・Docker socket・privileged・host network・公開ポートを持たない。
 * イメージは ID をそのまま渡す（タグを解決しない）。
 */
export function deployRunArgs(spec: DeployRunSpec, network: string = DEPLOY_NETWORK_NAME): string[] {
  return [
    'run',
    '-d',
    '--name',
    spec.name,
    '--label',
    DEPLOY_LABEL,
    '--network',
    network,
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
    `APP_VERSION=${spec.version}`,
    spec.digest,
  ];
}

/** `docker load` の出力から読み込まれたものを取り出す。ちょうど1つでなければ null。 */
export function parseLoadOutput(out: string): string | null {
  const refs = out
    .split('\n')
    .map((l) => /^Loaded image(?: ID)?: (\S+)$/.exec(l.trim())?.[1])
    .filter((r): r is string => r !== undefined);
  return refs.length === 1 ? (refs[0] as string) : null;
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

const LOAD_TIMEOUT_MS = 600_000;
const COMMAND_TIMEOUT_MS = 60_000;

export function createDeployDocker(options: { network?: string } = {}): DeployDocker {
  const network = options.network ?? DEPLOY_NETWORK_NAME;

  /** 内部ネットワークを用意する。同じ名前でラベルの無いものには触らず失敗にする。 */
  async function ensureNetwork(): Promise<void> {
    const listed = await docker(['network', 'ls', '--filter', `name=^${network}$`, '--format', '{{.Name}}'], COMMAND_TIMEOUT_MS);
    if (listed.trim() === '') {
      await docker(
        [
          'network',
          'create',
          '--internal',
          '--opt',
          'com.docker.network.bridge.enable_icc=false',
          '--label',
          DEPLOY_LABEL,
          network,
        ],
        COMMAND_TIMEOUT_MS,
      );
      return;
    }
    const facts = await docker(
      ['network', 'inspect', '--format', '{{.Internal}} {{index .Labels "msf.devline.deploy"}}', network],
      COMMAND_TIMEOUT_MS,
    );
    if (facts.trim() !== 'true 1') throw new DockerCommandError('同じ名前の別のネットワークがあります', null);
  }

  return {
    async loadImage(tarPath) {
      const out = await docker(['load', '-q', '-i', tarPath], LOAD_TIMEOUT_MS);
      const ref = parseLoadOutput(out);
      if (!ref) throw new DockerCommandError('読み込まれたイメージを特定できませんでした', null);
      const id = await docker(['image', 'inspect', '--format', '{{.Id}}', ref], COMMAND_TIMEOUT_MS);
      if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new DockerCommandError('イメージ ID を読めませんでした', null);
      return { ref, id };
    },

    async adoptImage({ ref, id, tag }) {
      await docker(['tag', id, tag], COMMAND_TIMEOUT_MS);
      if (ref !== id && ref !== tag) await docker(['image', 'rm', '--no-prune', ref], COMMAND_TIMEOUT_MS);
    },

    async discardImage(ref) {
      await docker(['image', 'rm', '--no-prune', ref], COMMAND_TIMEOUT_MS);
    },

    async hasImage(digest) {
      try {
        const tags = await docker(['image', 'inspect', '--format', '{{json .RepoTags}}', digest], COMMAND_TIMEOUT_MS);
        const parsed = JSON.parse(tags) as string[] | null;
        return (parsed ?? []).some((t) => t.startsWith(`${DEPLOY_IMAGE_REPO}:`));
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

    async run(spec) {
      await ensureNetwork();
      await docker(deployRunArgs(spec, network), COMMAND_TIMEOUT_MS);
      const ip = await docker(
        ['inspect', '--format', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, spec.name],
        COMMAND_TIMEOUT_MS,
      );
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new DockerCommandError('コンテナの IP を読めませんでした', null);
      return { baseUrl: `http://${ip}:${DEPLOY_CONTAINER_PORT}` };
    },

    async remove(name) {
      const state = await this.containerState(name);
      if (state === 'foreign') throw new DockerCommandError('同じ名前の別のコンテナがあります', null);
      if (state === 'none') return;
      await docker(['rm', '-f', name], COMMAND_TIMEOUT_MS);
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
    async check(base, sha) {
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
