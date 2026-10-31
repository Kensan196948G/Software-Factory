import type { FastifyReply, FastifyRequest } from 'fastify';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    correlationId?: string;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toBody(correlationId?: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
        ...(correlationId ? { correlationId } : {}),
      },
    };
  }
}

/** 画面の言い方（詳細仕様書 8-7）に対応するエラーを作る。 */
export const Errors = {
  required: (field?: string) => new ApiError('ERR-001', '必須の項目が入っていません', 400, field ? { field } : undefined),
  tooLong: (field?: string) =>
    new ApiError('ERR-002', '文字数が多すぎます（件名は60文字まで）', 400, field ? { field } : undefined),
  shape: (field?: string) =>
    new ApiError('ERR-003', '入力の形が正しくありません（全角数字は半角に直す）', 400, field ? { field } : undefined),
  notAllowedValue: (field?: string) => new ApiError('ERR-004', '選べない値です', 400, field ? { field } : undefined),
  criteriaLimit: () => new ApiError('ERR-006', '合格の条件は8件までです', 400),
  comboMismatch: (field?: string) =>
    new ApiError('ERR-013', '入力の組み合わせが合っていません（部署と道具）', 400, field ? { field } : undefined),
  idempotencyConflict: () => new ApiError('ERR-008', '同じ操作キーで違う内容が送られました', 409),
  noPermission: () => new ApiError('ERR-101', 'この操作をする権限がありません', 403),
  reasonRequired: () => new ApiError('ERR-102', '理由をメモに書いてください', 400),
  notFound: (what = '対象のデータ') => new ApiError('ERR-104', `${what}が見つかりません`, 404),
  selfApproval: () => new ApiError('ERR-105', '自分で自分を承認することはできません', 403),
  sessionExpired: () => new ApiError('ERR-106', 'ログインの期限が切れました（入力は残っています）', 401),
  invalidTransition: (reason: string, details?: unknown) =>
    new ApiError('ERR-201', reason || 'その状態へは変更できません', 409, details),
  approvalRequired: (message: string) => new ApiError('ERR-202', message, 409),
  signalIncomplete: (message: string) => new ApiError('ERR-203', message, 400),
  importInvalid: () => new ApiError('ERR-204', 'このファイルは取り込めません', 400),
  orderNotApproved: () => new ApiError('ERR-205', '承認されていない注文書は生成・投入できません', 409),
  conflict: (message = 'ほかの人が先に更新しました（最新を表示します）') => new ApiError('ERR-301', message, 409),
  busy: () => new ApiError('ERR-302', '混み合っています（少し待って再試行）', 429),
  internal: (message = '処理を完了できませんでした', correlationId?: string) =>
    new ApiError('ERR-401', message, 500, correlationId ? { correlationId } : undefined),
  numberingLimit: () => new ApiError('ERR-403', '受付番号の上限に達しました', 500),
  misconfigured: (message = 'システムの設定が合っていません') => new ApiError('ERR-405', message, 500),
};

export function sendError(reply: FastifyReply, err: unknown, correlationId?: string): void {
  if (err instanceof ApiError) {
    void reply.status(err.statusCode).send(err.toBody(correlationId));
    return;
  }
  void reply.status(500).send(Errors.internal(undefined, correlationId).toBody(correlationId));
}

export function correlationId(req: FastifyRequest): string {
  const header = req.headers['x-correlation-id'];
  if (typeof header === 'string' && header.length <= 64) return header;
  return `c-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/** セキュリティヘッダ。CSP は同一オリジンのみ（外部 CDN を使わない）。 */
export function applySecurityHeaders(reply: FastifyReply): void {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join('; '),
  );
}
