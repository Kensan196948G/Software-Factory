#!/usr/bin/env node
/**
 * 開発・実測用のSMTP受け皿（TLS・AUTH PLAIN/LOGIN対応）。
 *
 *   SMTP_SINK_TLS_CERT=/tmp/ca.crt は任意。指定すると暗黙TLSで待ち受ける。
 *   SMTP_SINK_AUTH=user:pass を指定すると AUTH を要求する。
 *
 *   node scripts/dev-smtp-sink.mjs
 */
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.SMTP_SINK_PORT ?? 2525);
const dir = process.env.SMTP_SINK_DIR ?? '.mail/smtp-in';
const certPath = process.env.SMTP_SINK_TLS_CERT;
const keyPath = process.env.SMTP_SINK_TLS_KEY;
const auth = process.env.SMTP_SINK_AUTH;

fs.mkdirSync(dir, { recursive: true });

function session(socket) {
  let buf = '';
  let inData = false;
  let msg = [];
  socket.setEncoding('utf8');
  socket.write('220 dev-smtp-sink ESMTP\r\n');
  socket.on('data', (chunk) => {
    buf += chunk;
    for (;;) {
      const idx = buf.indexOf('\r\n');
      if (idx < 0) break;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.eml`;
          fs.writeFileSync(path.join(dir, name), msg.join('\r\n') + '\r\n', { mode: 0o600 });
          msg = [];
          socket.write('250 OK\r\n');
        } else {
          msg.push(line);
        }
        continue;
      }
      const up = line.toUpperCase();
      if (up.startsWith('EHLO')) {
        socket.write(`250-dev-smtp-sink\r\n${auth ? '250-AUTH PLAIN LOGIN\r\n' : ''}250 OK\r\n`);
      } else if (up.startsWith('HELO')) {
        socket.write('250 OK\r\n');
      } else if (up.startsWith('AUTH PLAIN')) {
        const b64 = line.split(/\s+/)[2] ?? '';
        const parts = Buffer.from(b64, 'base64').toString('utf8').split('\0');
        const ok = Boolean(auth) && `${parts[1]}:${parts[2]}` === auth;
        socket.write(ok ? '235 2.7.0 OK\r\n' : '535 5.7.8 auth failed\r\n');
      } else if (up.startsWith('MAIL FROM') || up.startsWith('RCPT TO') || up === 'RSET' || up === 'NOOP') {
        socket.write('250 OK\r\n');
      } else if (up === 'DATA') {
        inData = true;
        socket.write('354 go ahead\r\n');
      } else if (up === 'QUIT') {
        socket.write('221 bye\r\n');
        socket.end();
      } else {
        socket.write('250 OK\r\n');
      }
    }
  });
  socket.on('error', () => undefined);
}

const server =
  certPath && keyPath
    ? tls.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, session)
    : net.createServer(session);
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ port, dir, tls: Boolean(certPath && keyPath), auth: Boolean(auth) }));
});
