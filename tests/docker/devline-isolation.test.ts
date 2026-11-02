/**
 * 実 Docker での隔離の確認（`pnpm test:docker`）。前提: docs/devline/real-runner.md の手順でイメージを作ってあること。
 * 宛先は自分で立てたダミーのコンテナだけ。Anthropic API にも外部にも送らない。
 * - claude は `--network none` でしか起動しない。
 * - プロキシの許可先（api.anthropic.com）への接続は試さない（単体試験で別のダミーへ確かめている）。
 * - 外部の名前は引かない。DNS の確認は `.invalid` を `--dns 127.0.0.1` のコンテナからだけ引く。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROXY_IMAGE,
  RUNNER_IMAGE,
  buildClaudeArgs,
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

/** コンテナの中で偽の API を立て、実 CLI に決まった工具の呼び出しをさせる。Anthropic へは送らない。 */
const OFFLINE_CLI_PROBE = String.raw`import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
const HOOK = JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'touch /tmp/HOOK_RAN' }] }] } });
const steps = process.env.PROBE_PLAN ? [['StructuredOutput', { summary: 'plan', needs_human: false }]] : [
  ['Edit', { file_path: '/workspace/t.txt', old_string: '', new_string: 'hello\n' }],
  ['Read', { file_path: '/workspace/t.txt' }],
  ['Read', { file_path: '/proc/self/environ' }],
  ['Read', { file_path: '/proc/1/environ' }],
  ['Edit', { file_path: '/workspace/.claude/settings.json', old_string: '', new_string: HOOK }],
  ['Read', { file_path: '/workspace/t.txt' }],
  ['Bash', { command: 'echo RAN', description: 'p' }],
];
let tools = null;
const results = [];
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
  res.end();
};
const start = (id) => ({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'stub', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
const finish = (reason) => [{ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (!req.url.includes('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":1}');
      return;
    }
    const j = JSON.parse(body || '{}');
    if (tools === null && j.tools?.length) tools = j.tools.map((t) => t.name).filter((n) => n !== 'StructuredOutput').sort();
    const done = (j.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_result');
    results.length = 0;
    done.forEach((t, i) => results.push({ name: steps[i]?.[0], isError: t.is_error === true, text: (typeof t.content === 'string' ? t.content : JSON.stringify(t.content)).slice(0, 200) }));
    const step = steps[done.length];
    if (!step) {
      sse(res, [start('e'), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }, ...finish('end_turn')]);
      return;
    }
    sse(res, [start('m' + done.length), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_' + done.length, name: step[0], input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step[1]) } }, ...finish('tool_use')]);
  });
});
server.listen(9099, '127.0.0.1', () => {
  const [cmd, ...args] = JSON.parse(readFileSync('/probe/args.json', 'utf8'));
  if (!process.env.PROBE_PLAN) args.splice(args.indexOf('--json-schema'), 2);
  const child = spawn(cmd, args, { cwd: '/workspace', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ANTHROPIC_API_KEY: 'sk-dummy-not-real', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9099', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  const killer = setTimeout(() => child.kill('SIGKILL'), 60000);
  child.on('close', (code) => {
    clearTimeout(killer);
    const files = readdirSync('/workspace', { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
    console.log(JSON.stringify({ code, stderr: stderr.slice(0, 400), tools, results, files, content: existsSync('/workspace/t.txt') ? readFileSync('/workspace/t.txt', 'utf8') : null, hookRan: existsSync('/tmp/HOOK_RAN'), cli: stdout.trim().startsWith('{') ? JSON.parse(stdout) : null }));
    process.exit(0);
  });
});
`;

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

interface OfflineCliResult {
  code: number;
  stderr: string;
  tools: string[];
  results: { name: string; isError: boolean; text: string }[];
  files: string[];
  content: string | null;
  hookRan: boolean;
  cli: { structured_output?: unknown } | null;
}

/** 実 CLI を本番の引数で動かす（--network none、ダミーのキー。費用なし）。 */
function runOfflineCli(step: 'plan' | 'implement'): OfflineCliResult {
  const dir = mkdtempSync(join(tmpdir(), 'msf-dl-cli-'));
  // mkdtemp は 0700。ホストの uid がコンテナの 1000 と違う環境（CI は 1001）でも読めるようにする。
  // 中身は試験用の引数と探査スクリプトだけで、読み取り専用で渡す。
  chmodSync(dir, 0o755);
  try {
    writeFileSync(
      join(dir, 'args.json'),
      JSON.stringify(buildClaudeArgs({ prompt: 'probe', step, maxTurns: 40, maxBudgetUsd: 1 })),
    );
    writeFileSync(join(dir, 'probe.mjs'), OFFLINE_CLI_PROBE);
    const out = docker(
      'run',
      '--rm',
      '--network',
      'none',
      ...HARDENED,
      '--tmpfs',
      '/workspace:rw,uid=1000',
      '--user',
      '1000:1000',
      '--env',
      'HOME=/tmp/home',
      ...(step === 'plan' ? ['--env', 'PROBE_PLAN=1'] : []),
      '--mount',
      `type=bind,src=${dir},dst=/probe,readonly`,
      '--workdir',
      '/workspace',
      RUNNER_IMAGE,
      'node',
      '/probe/probe.mjs',
    );
    return JSON.parse(out.slice(out.lastIndexOf('\n') + 1)) as OfflineCliResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

  it('実 CLI と偽の API: 実装の工具は Read と Edit だけで、Bash、/proc、hook へ届かず、作業場所に余計なファイルを残さない', () => {
    const r = runOfflineCli('implement');
    expect(r.stderr).not.toContain('could not start');
    expect(r.code).toBe(0);
    expect(r.tools).toEqual(['Edit', 'Read']);
    expect(r.results.map((x) => [x.name, x.isError])).toEqual([
      ['Edit', false],
      ['Read', false],
      ['Read', true],
      ['Read', true],
      ['Edit', true],
      ['Read', false],
      ['Bash', true],
    ]);
    expect(JSON.stringify(r.results)).not.toContain('sk-dummy-not-real');
    expect(r.hookRan).toBe(false);
    expect(r.files).toEqual(['t.txt']);
    expect(r.content).toBe('hello\n');
  });

  it('実 CLI と偽の API: 計画の工具は Read だけで、--json-schema の結果を返せる', () => {
    const r = runOfflineCli('plan');
    expect(r.stderr).not.toContain('could not start');
    expect(r.code).toBe(0);
    expect(r.tools).toEqual(['Read']);
    expect(r.cli?.structured_output).toEqual({ summary: 'plan', needs_human: false });
    expect(r.files).toEqual([]);
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
