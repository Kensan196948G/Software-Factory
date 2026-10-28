import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMimeMessage,
  deliverMail,
  encodeHeader,
  isEmailAddress,
  mailStatus,
  renderApprovalRequest,
  renderStallReminder,
} from '../../src/api/mailer.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'msf-mail-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('承認依頼メールの本文', () => {
  const input = {
    requestId: 'REQ-2026-0012',
    title: '工事写真の圏外保存',
    applicant: '山田 太郎',
    deptName: '海上土木部',
    signal: 'g' as const,
    criteriaCount: 3,
    baseUrl: 'https://sf.example.com/',
  };

  it('受付番号・件名・依頼者・部署・信号・リンクを載せる', () => {
    const mail = renderApprovalRequest(input);
    expect(mail.subject).toBe('【みらいSF】承認依頼 REQ-2026-0012 工事写真の圏外保存');
    expect(mail.body).toContain('受付番号: REQ-2026-0012');
    expect(mail.body).toContain('件名: 工事写真の圏外保存');
    expect(mail.body).toContain('依頼者: 山田 太郎');
    expect(mail.body).toContain('部署: 海上土木部');
    expect(mail.body).toContain('信号の候補: 青');
    expect(mail.body).toContain('合格の条件: 3件');
    expect(mail.body).toContain('承認する画面: https://sf.example.com/（');
  });

  it('信号が未決定なら「信号の候補」を書かない', () => {
    const mail = renderApprovalRequest({ ...input, signal: null });
    expect(mail.body).not.toContain('信号の候補');
    expect(mail.body).toContain('承認待ち');
  });
});

describe('宛先とヘッダ', () => {
  it('改行を含む宛先は受け付けない（ヘッダ注入を防ぐ）', () => {
    expect(isEmailAddress('approver@example.com')).toBe(true);
    expect(isEmailAddress('a@b.co\nBcc: evil@example.com')).toBe(false);
    expect(isEmailAddress('not-an-email')).toBe(false);
    expect(isEmailAddress('')).toBe(false);
  });

  it('日本語の件名は RFC 2047 で包み、ASCII はそのまま', () => {
    expect(encodeHeader('Approval request')).toBe('Approval request');
    expect(encodeHeader('承認依頼')).toBe(`=?UTF-8?B?${Buffer.from('承認依頼', 'utf8').toString('base64')}?=`);
  });

  it('件名の改行（ヘッダ注入）は行を増やさない', () => {
    const mime = buildMimeMessage({ to: 'approver@example.com', subject: '承認\r\nBcc: evil@example.com', body: '本文' });
    const headerBlock = mime.split('\r\n\r\n')[0]!;
    expect(headerBlock).not.toContain('\nBcc:');
    expect(headerBlock).not.toContain('\r\nBcc:');
    expect(headerBlock.split('\r\n').filter((l) => l.startsWith('Bcc:')).length).toBe(0);
  });

  it('MIME は UTF-8 の base64 で、本文を復元できる', () => {
    const mime = buildMimeMessage(
      { to: 'approver@example.com', subject: '承認依頼 テスト', body: '本文です。\n2行目', requestId: 'REQ-2026-0012' },
      new Date('2026-10-28T00:00:00Z'),
    );
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime).toContain('Content-Transfer-Encoding: base64');
    expect(mime).toContain('X-Mirai-SF-Request-Id: REQ-2026-0012');
    const [, encoded = ''] = mime.split('\r\n\r\n');
    expect(Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('本文です。\n2行目');
  });
});

describe('送信経路（外部サービスを呼ばない）', () => {
  it('file モードは .eml を書き出す', async () => {
    const dir = tempDir();
    const result = await deliverMail(
      { to: 'approver@example.com', subject: '承認依頼', body: '本文', requestId: 'REQ-2026-0001' },
      { mode: 'file', outboxDir: dir },
    );
    expect(result.ok).toBe(true);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const written = readFileSync(join(dir, files[0]!), 'utf8');
    expect(written).toContain('To: approver@example.com');
    expect(written).toContain('X-Mirai-SF-Request-Id: REQ-2026-0001');
  });

  it('off モードは送らない（理由を返す）', async () => {
    const result = await deliverMail({ to: 'approver@example.com', subject: 's', body: 'b' }, { mode: 'off' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('off');
  });

  it('宛先が不正なら送らない', async () => {
    const result = await deliverMail({ to: 'a@b\nCc: x@y', subject: 's', body: 'b' }, { mode: 'file', outboxDir: tempDir() });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('宛先が不正');
  });

  it('MTA が stdin を読まずに終了しても落ちない（EPIPE）', async () => {
    const dir = tempDir();
    const script = join(dir, 'sendmail-noread.sh');
    writeFileSync(script, '#!/bin/sh\nexit 0\n');
    chmodSync(script, 0o755);
    const result = await deliverMail(
      { to: 'approver@example.com', subject: 's', body: 'b'.repeat(4096) },
      { mode: 'sendmail', sendmailPath: script },
    );
    // 0 で終わるので成功として扱う。重要なのは未処理例外で落ちないこと
    expect(result.ok).toBe(true);
  });

  it('sendmail が 0 で終われば成功、非 0 なら理由付きで失敗する', async () => {
    const dir = tempDir();
    const okScript = join(dir, 'sendmail-ok.sh');
    writeFileSync(okScript, '#!/bin/sh\ncat > /dev/null\nexit 0\n');
    chmodSync(okScript, 0o755);
    const ok = await deliverMail({ to: 'approver@example.com', subject: 's', body: 'b' }, { mode: 'sendmail', sendmailPath: okScript });
    expect(ok.ok).toBe(true);

    const failScript = join(dir, 'sendmail-fail.sh');
    writeFileSync(failScript, '#!/bin/sh\ncat > /dev/null\necho "no MTA" >&2\nexit 75\n');
    chmodSync(failScript, 0o755);
    const failed = await deliverMail(
      { to: 'approver@example.com', subject: 's', body: 'b' },
      { mode: 'sendmail', sendmailPath: failScript },
    );
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain('no MTA');
  });

  it('設定の要約に Secrets を含めない', () => {
    const status = mailStatus();
    expect(status.mode).toBe('file');
    expect(Object.keys(status).sort()).toEqual(['from', 'mode', 'ready']);
  });
});


describe('滞留通知メール', () => {
  it('滞留日数・状態・リンクを載せる', () => {
    const mail = renderStallReminder({
      requestId: 'REQ-2026-0007',
      title: '工事写真の圏外保存',
      applicant: '山田 太郎',
      deptName: '海上土木部',
      statusLabel: '承認待ち',
      days: 3,
      baseUrl: 'https://sf.example.com/',
    });
    expect(mail.subject).toContain('滞留');
    expect(mail.subject).toContain('REQ-2026-0007');
    expect(mail.body).toContain('「承認待ち」のまま 3 日止まっています');
    expect(mail.body).toContain('https://sf.example.com/');
    expect(mail.body).toContain('1日1回');
  });
});


/** テスト用の最小SMTPサーバ（DATA をそのまま集める）。 */
async function startFakeSmtp(): Promise<{ port: number; lines: string[]; close: () => Promise<void> }> {
  const lines: string[] = [];
  const server = net.createServer((socket) => {
    let buf = '';
    let inData = false;
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const idx = buf.indexOf('\r\n');
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 OK\r\n');
          } else {
            lines.push(line);
          }
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) socket.write('250-fake\r\n250 OK\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 End data\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    lines,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('SMTP送信', () => {
  it('SMTPサーバへ1通渡す（ヘッダとリクエストIDが乗る）', async () => {
    const smtp = await startFakeSmtp();
    try {
      const result = await deliverMail(
        { to: 'approver@example.com', subject: '承認依頼', body: '本文', requestId: 'REQ-2026-0099' },
        {
          mode: 'smtp',
          smtpHost: '127.0.0.1',
          smtpPort: smtp.port,
          smtpSecure: false,
          smtpRequireTls: false,
          smtpUser: '',
          smtpPass: '',
        },
      );
      expect(result.ok).toBe(true);
      const raw = smtp.lines.join('\n');
      expect(raw).toContain('To: approver@example.com');
      expect(raw.toLowerCase()).toContain('x-mirai-sf-request-id: req-2026-0099');
    } finally {
      await smtp.close();
    }
  });

  it('接続できないときは ok:false（例外にしない）', async () => {
    const result = await deliverMail(
      { to: 'approver@example.com', subject: 's', body: 'b' },
      { mode: 'smtp', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecure: false, smtpRequireTls: false, smtpUser: '', smtpPass: '' },
    );
    expect(result.ok).toBe(false);
    expect(result.transport).toBe('smtp');
  });

  it('SMTP_HOST が未設定なら ok:false', async () => {
    const result = await deliverMail({ to: 'approver@example.com', subject: 's', body: 'b' }, { mode: 'smtp', smtpHost: '' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('SMTP_HOST');
  });
});
