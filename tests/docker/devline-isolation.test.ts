/**
 * 実 Docker での隔離の確認（`pnpm test:docker`）。前提: docs/devline/real-runner.md の手順でイメージを作ってあること。
 * 宛先は自分で立てたダミーのコンテナだけ。Anthropic API にも外部にも送らない。
 * - claude は `--network none` でしか起動しない。
 * - プロキシの許可先（api.anthropic.com）への接続は試さない（単体試験で別のダミーへ確かめている）。
 * - 外部の名前は引かない。DNS の確認は `.invalid` を `--dns 127.0.0.1` のコンテナからだけ引く。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROXY_IMAGE,
  RUNNER_IMAGE,
  egressNetworkArgs,
  internalNetworkArgs,
  proxyRunArgs,
} from '../../src/worker/docker-claude-runner.js';

const id = randomBytes(4).toString('hex');
const internal = `msf-dl-test-int-${id}`;
const egress = `msf-dl-test-egr-${id}`;
const proxy = `msf-dl-test-proxy-${id}`;
const dummy = `msf-dl-test-dummy-${id}`;

const HARDENED = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp'];

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryDocker(...args: string[]): { code: number | null; out: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 隔離ネットワーク上の使い捨てコンテナで node を動かす。ランナーと同じ制限にする。 */
function onInternal(script: string): { code: number | null; out: string } {
  return tryDocker(
    'run',
    '--rm',
    '--network',
    internal,
    '--dns',
    '127.0.0.1',
    ...HARDENED,
    '--entrypoint',
    'node',
    PROXY_IMAGE,
    '-e',
    script,
  );
}

const CONNECT_SCRIPT = (target: string, host: string): string => `
const net = require('node:net');
const s = net.connect({ host: ${JSON.stringify(host)}, port: 3128 });
s.setTimeout(8000, () => { console.log('TIMEOUT'); process.exit(3); });
s.on('error', (e) => { console.log('ERROR ' + e.code); process.exit(2); });
s.on('connect', () => s.write('CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n\\r\\n'));
s.on('data', (d) => { console.log(String(d).split('\\r\\n')[0]); process.exit(0); });
`;

const DIRECT_SCRIPT = (host: string, port: number): string => `
const net = require('node:net');
const s = net.connect({ host: ${JSON.stringify(host)}, port: ${port} });
s.setTimeout(4000, () => { console.log('UNREACHABLE timeout'); process.exit(0); });
s.on('error', (e) => { console.log('UNREACHABLE ' + e.code); process.exit(0); });
s.on('connect', () => { console.log('REACHED'); process.exit(0); });
`;

let dummyIp = '';

beforeAll(() => {
  docker(...internalNetworkArgs(internal));
  docker(...egressNetworkArgs(egress));
  // 外のネットワーク側に自分のダミーを置く。ここへ届かないことを確かめる
  docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    dummy,
    '--label',
    'msf.devline=1',
    '--network',
    egress,
    '--entrypoint',
    'node',
    PROXY_IMAGE,
    '-e',
    "require('node:http').createServer((q,r)=>r.end('dummy')).listen(8080,'0.0.0.0')",
  );
  dummyIp = docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${egress}").IPAddress}}`, dummy);
  docker(...proxyRunArgs({ name: proxy, network: egress, image: PROXY_IMAGE }));
  docker('network', 'connect', internal, proxy);
  for (let i = 0; i < 40; i += 1) {
    if (docker('logs', proxy).includes('egress-proxy listening')) break;
    spawnSync('sleep', ['0.25']);
  }
});

afterAll(() => {
  tryDocker('kill', proxy);
  tryDocker('kill', dummy);
  tryDocker('network', 'rm', internal);
  tryDocker('network', 'rm', egress);
});

describe('runner イメージ', () => {
  it(`${RUNNER_IMAGE}: 固定した版の claude が非 root・読み取り専用で起動する（--network none）`, () => {
    const version = docker(
      'run',
      '--rm',
      '--network',
      'none',
      ...HARDENED,
      '--user',
      '1000:1000',
      '--env',
      'DISABLE_AUTOUPDATER=1',
      '--env',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
      RUNNER_IMAGE,
      'claude',
      '--version',
    );
    expect(version).toContain('2.1.316');
    const probe = tryDocker(
      'run',
      '--rm',
      '--network',
      'none',
      ...HARDENED,
      '--user',
      '1000:1000',
      RUNNER_IMAGE,
      'sh',
      '-c',
      'id -u; touch /x 2>&1 || echo READONLY; ls -a /home; ls -a /root 2>&1 | head -1',
    );
    expect(probe.out).toContain('1000');
    expect(probe.out).toContain('READONLY');
  });

  it('実際の隔離の条件で CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 の CLI が起動する（キーなし、--network none で費用なし）', () => {
    const run = tryDocker(
      'run',
      '--rm',
      '--network',
      'none',
      ...HARDENED,
      '--user',
      '1000:1000',
      '--env',
      'HOME=/tmp/home',
      '--env',
      'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1',
      RUNNER_IMAGE,
      'sh',
      '-c',
      'mkdir -p "$HOME"; cd /tmp; timeout 40 claude --bare -p hi --output-format json 2>&1; echo "rc=$?"; command -v bwrap',
    );
    expect(run.out).not.toContain('could not start');
    expect(run.out).toContain('"total_cost_usd":0');
    expect(run.out).toContain('/usr/bin/bwrap');
  });

  it('確認済みのフラグが --help にある（--max-turns は help に出ない）', () => {
    const help = docker('run', '--rm', '--network', 'none', ...HARDENED, '--user', '1000:1000', RUNNER_IMAGE, 'claude', '--help');
    for (const flag of [
      '--bare',
      '--print',
      '--output-format',
      '--json-schema',
      '--max-budget-usd',
      '--permission-mode',
      '--permission-prompts',
      '--tools',
      '--allowedTools',
      '--disallowedTools',
      '--no-session-persistence',
    ]) {
      expect(help, flag).toContain(flag);
    }
  });
});

describe('隔離ネットワーク', () => {
  it('docker network inspect: internal で、ホスト側のゲートウェイを持たない', () => {
    const info = JSON.parse(docker('network', 'inspect', internal))[0];
    expect(info.Internal).toBe(true);
    expect(info.Options['com.docker.network.bridge.inhibit_ipv4']).toBe('true');
    expect(info.IPAM.Config.every((c: { Gateway?: string }) => !c.Gateway)).toBe(true);
  });

  it('コンテナに既定の経路が無い', () => {
    const r = onInternal(`console.log(require('node:fs').readFileSync('/proc/net/route','utf8'))`);
    const routes = r.out
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/)[1]);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes).not.toContain('00000000');
  });

  it('外のネットワークのダミーへ直接は届かない（プロキシの迂回ができない）', () => {
    expect(dummyIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const r = onInternal(DIRECT_SCRIPT(dummyIp, 8080));
    expect(r.out).toContain('UNREACHABLE');
    expect(r.out).not.toContain('REACHED');
  });

  it('プロキシの名前は解決できるが、外の名前は解決できない（--dns 127.0.0.1）', () => {
    const script = (name: string): string =>
      `require('node:dns').lookup(${JSON.stringify(name)},(e,a)=>{console.log(e?'NXDOMAIN '+e.code:'RESOLVED '+a);process.exit(0)})`;
    expect(onInternal(script(proxy)).out).toContain('RESOLVED');
    expect(onInternal(script('msf-devline-test.invalid')).out).toContain('NXDOMAIN');
    expect(onInternal(script(dummy)).out).toContain('NXDOMAIN');
  });

  it('プロキシ経由でも許可先以外は 403（ダミーの IP・名前・別のポート）', () => {
    for (const target of [
      `${dummyIp}:8080`,
      `${dummy}:8080`,
      'api.anthropic.com:80',
      'api.anthropic.com.:443',
      'API.ANTHROPIC.COM:443',
      'github.com:443',
    ]) {
      const r = onInternal(CONNECT_SCRIPT(target, proxy));
      expect(r.out, target).toContain('403');
    }
    // ダミーのコンテナには1件も届いていない
    const logs = JSON.parse(
      `[${docker('logs', proxy)
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .join(',')}]`,
    ) as { decision: string }[];
    expect(logs.length).toBeGreaterThanOrEqual(6);
    expect(logs.every((l) => l.decision === 'deny')).toBe(true);
  });

  it('プロキシのコンテナは権限を落として動いている', () => {
    const info = JSON.parse(docker('inspect', proxy))[0];
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.HostConfig.CapDrop).toContain('ALL');
    expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(info.Config.User).toBe('1000:1000');
  });
});
