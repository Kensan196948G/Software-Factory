/**
 * 承認依頼メール（FR-44 のうち「承認依頼」だけを最小構成で実装）。
 *
 * 送信経路は3つ。どれも外部サービスを呼ばない（個人利用MVPの前提）。
 *   off      送らない（本番の既定。通知連携は対象外のため）
 *   file     ローカルの送信BOX（.mail/outbox など）へ .eml を書き出す（開発・テストの既定）
 *   sendmail ローカルMTA（sendmail -t -i）へ1通ずつ渡す
 *
 * Secrets は持たない。SMTP のホスト・認証はこのモジュールの責務外（docs/limitations.md）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { SIGNAL_LABEL, type Signal } from '../shared/domain.js';

export type MailMode = 'off' | 'file' | 'sendmail';

export interface MailDraft {
  to: string;
  subject: string;
  body: string;
  /** 追跡用（X-Mirai-SF-Request-Id） */
  requestId?: string;
}

export interface DeliveryResult {
  ok: boolean;
  transport: MailMode;
  /** 成功時は書き出したファイルのパスなど */
  detail?: string;
}

export interface DeliverOptions {
  mode?: MailMode;
  outboxDir?: string;
  sendmailPath?: string;
}

const HEADER_UNSAFE = /[\r\n]/;

/** メールアドレスとして使える形か（ヘッダ注入を防ぐため改行は必ず弾く）。 */
export function isEmailAddress(value: string): boolean {
  if (!value || value.length > 254 || HEADER_UNSAFE.test(value)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** 件名などの日本語を RFC 2047 で包む。 */
export function encodeHeader(value: string): string {
  if (!value) return '';
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function base64Lines(value: string): string {
  return (Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

function rfc2822Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000');
}

/** RFC 5322 の最小ヘッダ＋本文（base64）を組み立てる。 */
export function buildMimeMessage(mail: MailDraft, now: Date = new Date()): string {
  const headers = [
    `From: ${encodeAddress(config.mailFrom)}`,
    `To: ${encodeAddress(mail.to)}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${rfc2822Date(now)}`,
    `Message-ID: <${randomUUID()}@mirai-sf.local>`,
    ...(mail.requestId ? [`X-Mirai-SF-Request-Id: ${mail.requestId.replace(HEADER_UNSAFE, ' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${base64Lines(mail.body)}\r\n`;
}

function encodeAddress(address: string): string {
  return address.replace(HEADER_UNSAFE, ' ');
}

/** 送信経路の設定を読む（テストで上書きできるように引数でも渡せる）。 */
export function resolveMode(options: DeliverOptions = {}): MailMode {
  return options.mode ?? config.mailMode;
}

export function outboxDir(options: DeliverOptions = {}): string {
  return resolve(options.outboxDir ?? config.mailOutboxDir);
}

/** 1通送る。失敗しても throw しない（呼び出し側が status='failed' として残す）。 */
export async function deliverMail(mail: MailDraft, options: DeliverOptions = {}): Promise<DeliveryResult> {
  const mode = resolveMode(options);
  if (mode === 'off') return { ok: false, transport: mode, detail: 'MAIL_MODE=off（送信しない設定）' };
  if (!isEmailAddress(mail.to)) return { ok: false, transport: mode, detail: `宛先が不正です: ${mail.to}` };

  const mime = buildMimeMessage(mail);
  if (mode === 'file') {
    try {
      const dir = outboxDir(options);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.eml`);
      writeFileSync(path, mime, { encoding: 'utf8', mode: 0o600 });
      return { ok: true, transport: mode, detail: path };
    } catch (err) {
      return { ok: false, transport: mode, detail: (err as Error).message };
    }
  }

  const sendmail = options.sendmailPath ?? config.sendmailPath;
  return new Promise<DeliveryResult>((done) => {
    let settled = false;
    const finish = (result: DeliveryResult) => {
      if (settled) return;
      settled = true;
      done(result);
    };
    let stderr = '';
    const child = spawn(sendmail, ['-t', '-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, transport: mode, detail: 'sendmail が応答しません（10秒で打ち切り）' });
    }, 10_000);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 500);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, transport: mode, detail: `${sendmail} を起動できません: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) finish({ ok: true, transport: mode, detail: sendmail });
      else finish({ ok: false, transport: mode, detail: `sendmail が終了コード ${String(code)} で失敗: ${stderr.trim()}` });
    });
    child.stdin?.end(mime);
  });
}

/** 画面・APIに出す設定の要約（Secrets は含めない）。 */
export function mailStatus(): { mode: MailMode; ready: boolean; from: string; outboxDir: string | null } {
  return {
    mode: config.mailMode,
    ready: config.mailMode !== 'off',
    from: config.mailFrom,
    outboxDir: config.mailMode === 'file' ? outboxDir() : null,
  };
}

export interface ApprovalMailInput {
  requestId: string;
  title: string;
  applicant: string;
  deptName: string;
  signal: Signal | null;
  criteriaCount: number;
  baseUrl: string;
}

/** 承認依頼メールの件名・本文（純粋関数）。小さな事実だけを載せ、Secrets は入れない。 */
export function renderApprovalRequest(input: ApprovalMailInput): { subject: string; body: string } {
  const url = `${input.baseUrl.replace(/\/+$/, '')}/`;
  const subject = `【みらいSF】承認依頼 ${input.requestId} ${input.title}`;
  const lines = [
    `${input.deptName} ご担当者さま`,
    '',
    'みらいSF 受付ステーションです。',
    '次の依頼が「承認待ち」になりました。承認をお願いします。',
    '',
    `受付番号: ${input.requestId}`,
    `件名: ${input.title}`,
    `依頼者: ${input.applicant}`,
    `部署: ${input.deptName}`,
  ];
  if (input.signal) lines.push(`信号の候補: ${SIGNAL_LABEL[input.signal]}`);
  lines.push(
    `合格の条件: ${input.criteriaCount}件`,
    '',
    `承認する画面: ${url}（「承認待ち」の一覧から開いてください）`,
    '',
    '※ このメールは自動送信です。心当たりがない場合は受付担当へご連絡ください。',
  );
  return { subject, body: lines.join('\n') };
}
