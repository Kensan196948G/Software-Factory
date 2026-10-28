let csrfToken = '';

export function setCsrfToken(token: string | null): void {
  csrfToken = token ?? '';
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method) && csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (opts.raw) {
    if (!res.ok) throw await toError(res);
    return (await res.text()) as T;
  }

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    const err = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiClientError(res.status, err?.code ?? 'ERR-401', err?.message ?? '処理を完了できませんでした', err?.details);
  }
  return payload as T;
}

async function toError(res: Response): Promise<ApiClientError> {
  const text = await res.text().catch(() => '');
  let message = '処理を完了できませんでした';
  let code = 'ERR-401';
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
    message = parsed.error?.message ?? message;
    code = parsed.error?.code ?? code;
  } catch {
    /* noop */
  }
  return new ApiClientError(res.status, code, message);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>(path, { method: 'POST', body, headers }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  text: (path: string) => request<string>(path, { raw: true }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return `${err.message}（${err.code}）`;
  if (err instanceof Error) return err.message;
  return '処理を完了できませんでした';
}
