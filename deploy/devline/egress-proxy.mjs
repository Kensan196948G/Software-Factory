#!/usr/bin/env node
/**
 * 開発ラインの通信制限プロキシ（外部依存なし）。
 * CONNECT で許可先（既定は api.anthropic.com:443 だけ）へのトンネルを張る。それ以外はすべて拒否する。
 * - 許可先はコードの定数。環境変数からは広げられない（試験は createEgressProxy の引数で差し替える）。
 * - 中身は読まない（TLS のまま通す）。記録するのは宛先と可否だけ。
 * - 名前解決の結果が内部のアドレスなら接続しない（DNS の差し替えで内部へ向けられないように）。
 */
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { connect, isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

export const DEFAULT_ALLOW = Object.freeze(['api.anthropic.com:443']);
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 15 * 1000;

/** CONNECT の宛先を厳密に解釈する。読めないものは null。大文字・末尾の点・IP 直書きは許可しない。 */
export function parseConnectTarget(raw) {
  const m = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):([1-9][0-9]{0,4})$/.exec(String(raw ?? ''));
  if (!m) return null;
  const host = m[1];
  const port = Number(m[2]);
  if (port > 65535 || isIP(host) !== 0) return null;
  return { host, port, key: `${host}:${port}` };
}

export function isAllowedTarget(raw, allow = DEFAULT_ALLOW) {
  const target = parseConnectTarget(raw);
  return target !== null && allow.includes(target.key);
}

/** ループバック・私設・リンクローカルなど、外部ではないアドレスか。 */
export function isPrivateAddress(address) {
  const lower = address.toLowerCase();
  if (isIP(lower) === 6) {
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  const parts = lower.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function refuse(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * @param {{allow?: readonly string[], allowPrivate?: boolean, log?: (line: object) => void}} [options]
 *   allow と allowPrivate は試験だけが渡す。起動時（main）は渡さない。
 */
export function createEgressProxy(options = {}) {
  const allow = options.allow ?? DEFAULT_ALLOW;
  const allowPrivate = options.allowPrivate === true;
  const log = options.log ?? (() => undefined);
  const server = createServer((req, res) => {
    // 平文の転送はしない
    log({ decision: 'deny', method: req.method, reason: 'not_connect' });
    res.writeHead(403, { connection: 'close', 'content-length': '0' });
    res.end();
  });
  server.maxHeadersCount = 50;
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;

  server.on('connect', (req, clientSocket, head) => {
    clientSocket.on('error', () => clientSocket.destroy());
    const target = parseConnectTarget(req.url);
    if (!target || !allow.includes(target.key)) {
      log({ decision: 'deny', target: String(req.url).slice(0, 200), reason: 'not_allowed' });
      refuse(clientSocket, 403, 'Forbidden');
      return;
    }
    void (async () => {
      let address;
      try {
        address = (await lookup(target.host)).address;
      } catch {
        log({ decision: 'deny', target: target.key, reason: 'dns_failed' });
        refuse(clientSocket, 502, 'Bad Gateway');
        return;
      }
      if (!allowPrivate && isPrivateAddress(address)) {
        log({ decision: 'deny', target: target.key, reason: 'private_address' });
        refuse(clientSocket, 403, 'Forbidden');
        return;
      }
      const upstream = connect({ host: address, port: target.port, timeout: CONNECT_TIMEOUT_MS });
      const fail = () => {
        upstream.destroy();
        refuse(clientSocket, 502, 'Bad Gateway');
      };
      upstream.once('error', fail);
      upstream.once('timeout', fail);
      upstream.once('connect', () => {
        upstream.removeListener('error', fail);
        upstream.removeListener('timeout', fail);
        log({ decision: 'allow', target: target.key });
        upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
        clientSocket.setTimeout(IDLE_TIMEOUT_MS, () => clientSocket.destroy());
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('close', () => upstream.destroy());
        upstream.on('close', () => clientSocket.destroy());
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
    })();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createEgressProxy({ log: (line) => console.log(JSON.stringify(line)) });
  server.listen(3128, '0.0.0.0', () => console.log('egress-proxy listening'));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
