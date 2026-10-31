/**
 * IssueAdapter の GitHub 実装（IF-03）。
 * 冪等性はここでは作らない。結果の分類（classifyIssueResponse）だけを行い、呼び出し側が intent で管理する。
 * 応答の全文や header は保存しない。token はこのファイルの外へ出さない。
 */
import type {
  IssueAdapter,
  IssueListPage,
  IssueReadResult,
  IssueSendOutcome,
  IssueSummary,
  IssueTransportFacts,
  IssueWriteInput,
} from '../shared/devline.js';
import { classifyIssueResponse } from '../shared/devline.js';
import { ApiError } from './http.js';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface GithubAdapterOptions {
  token: string;
  apiUrl: string;
  nodeEnv: string;
}

/**
 * 接続先の検査。試験ではループバック以外へ送らない（実 GitHub に届かないことをコードで保証する）。
 * それ以外でも token を平文で外へ出さない。
 */
export function assertApiUrlAllowed(apiUrl: string, nodeEnv: string): URL {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new ApiError('ERR-405', 'GITHUB_API_URL の形が正しくありません', 409);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (nodeEnv === 'test' && !loopback) {
    throw new ApiError('ERR-405', '試験ではローカルの連携先だけを使えます（GITHUB_API_URL）', 409);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ApiError('ERR-405', 'GITHUB_API_URL は https のみ使えます', 409);
  }
  return url;
}

function repoPath(repo: string): string {
  if (!REPO_RE.test(repo) || repo.split('/').some((s) => /^\.+$/.test(s))) {
    throw new ApiError('ERR-405', '対象リポジトリの形が正しくありません', 409);
  }
  return `/repos/${repo}`;
}

function isAbortLike(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function shortMessage(json: unknown): string | undefined {
  const message = (json as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message.slice(0, 300) : undefined;
}

function toSummary(raw: unknown): IssueSummary | null {
  const issue = raw as {
    number?: unknown;
    html_url?: unknown;
    body?: unknown;
    user?: { login?: unknown } | null;
    pull_request?: unknown;
  } | null;
  if (!issue || !Number.isInteger(issue.number) || typeof issue.html_url !== 'string') return null;
  return {
    number: issue.number as number,
    url: issue.html_url,
    body: typeof issue.body === 'string' ? issue.body : null,
    authorLogin: typeof issue.user?.login === 'string' ? issue.user.login : null,
    isPullRequest: issue.pull_request !== undefined && issue.pull_request !== null,
  };
}

/** Link header の rel="next" からページ番号を読む。 */
function nextPageFromLink(link: string | null): number | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    if (!/rel="?next"?/.test(part)) continue;
    const m = /[?&]page=(\d+)/.exec(part);
    if (m) return Number(m[1]);
  }
  return null;
}

export function createGithubIssueAdapter(options: GithubAdapterOptions): IssueAdapter {
  const base = assertApiUrlAllowed(options.apiUrl, options.nodeEnv).toString().replace(/\/$/, '');
  const headers = (json: boolean): Record<string, string> => ({
    authorization: `Bearer ${options.token}`,
    accept: 'application/vnd.github+json',
    ...(json ? { 'content-type': 'application/json' } : {}),
    'user-agent': 'mirai-sf-intake',
    'x-github-api-version': '2022-11-28',
  });

  /** 3xx は追わない（token を付けて別の場所へ送らない）。 */
  async function read(path: string, signal: AbortSignal): Promise<IssueReadResult<{ json: unknown; res: Response }>> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { method: 'GET', headers: headers(false), signal, redirect: 'manual' });
    } catch (err) {
      return { ok: false, reason: isAbortLike(err) ? 'timeout' : 'network' };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'http', httpStatus: res.status };
    }
    try {
      return { ok: true, value: { json: await res.json(), res } };
    } catch (err) {
      return isAbortLike(err) ? { ok: false, reason: 'timeout' } : { ok: false, reason: 'http', httpStatus: res.status };
    }
  }

  async function write(method: 'POST' | 'PATCH', path: string, input: IssueWriteInput): Promise<IssueSendOutcome> {
    let parsed: unknown = null;
    let number: number | undefined;
    let url: string | undefined;
    let retryAfter: number | undefined;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: headers(true),
        body: JSON.stringify({ title: input.title, body: input.body }),
        signal: input.signal,
        redirect: 'manual',
      });
    } catch (err) {
      return { outcome: 'unknown', reason: isAbortLike(err) ? 'timeout' : 'network' };
    }
    try {
      parsed = await res.json();
    } catch (err) {
      if (isAbortLike(err)) return { outcome: 'unknown', reason: 'timeout', httpStatus: res.status };
      parsed = null;
    }
    const summary = toSummary(parsed);
    if (summary && summary.number >= 1) {
      number = summary.number;
      url = summary.url;
    }
    const retryHeader = res.headers.get('retry-after');
    if (retryHeader !== null && /^\d+$/.test(retryHeader)) retryAfter = Number(retryHeader);
    const facts: IssueTransportFacts = {
      kind: 'http',
      status: res.status,
      bodyParsed: number !== undefined,
      retryAfterPresent: retryHeader !== null,
    };
    const outcome = classifyIssueResponse(facts);
    const message = shortMessage(parsed);
    if (outcome === 'succeeded') return { outcome, number: number as number, url: url as string };
    if (outcome === 'rate_limited') {
      return { outcome, httpStatus: res.status, ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }) };
    }
    if (outcome === 'failed') return { outcome, reason: 'http_4xx', httpStatus: res.status, ...(message ? { message } : {}) };
    return {
      outcome: 'unknown',
      reason: res.ok ? 'bad_response' : 'http',
      httpStatus: res.status,
      ...(message ? { message } : {}),
    };
  }

  return {
    kind: 'github',

    async getActorLogin(signal) {
      const got = await read('/user', signal);
      if (!got.ok) return got;
      const login = (got.value.json as { login?: unknown } | null)?.login;
      return typeof login === 'string' && login !== '' ? { ok: true, value: login } : { ok: false, reason: 'http' };
    },

    async getRepoId(repo, signal) {
      const got = await read(repoPath(repo), signal);
      if (!got.ok) return got;
      const id = (got.value.json as { id?: unknown } | null)?.id;
      return Number.isInteger(id) ? { ok: true, value: String(id) } : { ok: false, reason: 'http' };
    },

    async resolveBaseSha(repo, signal) {
      const path = repoPath(repo);
      const meta = await read(path, signal);
      if (!meta.ok) return meta;
      const branch = (meta.value.json as { default_branch?: unknown } | null)?.default_branch;
      if (typeof branch !== 'string' || branch === '') return { ok: false, reason: 'http' };
      const commit = await read(`${path}/commits/${encodeURIComponent(branch)}`, signal);
      if (!commit.ok) return commit;
      const sha = (commit.value.json as { sha?: unknown } | null)?.sha;
      return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? { ok: true, value: sha } : { ok: false, reason: 'http' };
    },

    createIssue(input) {
      return write('POST', `${repoPath(input.repo)}/issues`, input);
    },

    updateIssue(input) {
      return write('PATCH', `${repoPath(input.repo)}/issues/${input.issueNo}`, input);
    },

    async getIssue(repo, issueNo, signal) {
      const got = await read(`${repoPath(repo)}/issues/${issueNo}`, signal);
      if (!got.ok) {
        // 消された Issue は「無い」という確かな結果
        return got.httpStatus === 404 || got.httpStatus === 410 ? { ok: true, value: null } : got;
      }
      const summary = toSummary(got.value.json);
      return summary ? { ok: true, value: summary } : { ok: false, reason: 'http' };
    },

    async listIssuesSince(input, signal) {
      const params = new URLSearchParams({
        state: 'all',
        since: input.since.toISOString(),
        sort: 'created',
        direction: 'asc',
        per_page: String(input.perPage),
        page: String(input.page),
      });
      const got = await read(`${repoPath(input.repo)}/issues?${params.toString()}`, signal);
      if (!got.ok) return got;
      if (!Array.isArray(got.value.json)) return { ok: false, reason: 'http' };
      const issues: IssueSummary[] = [];
      for (const raw of got.value.json) {
        const summary = toSummary(raw);
        // 読めない行を黙って飛ばすと「無い」と誤判定するので、走査の失敗にする
        if (!summary) return { ok: false, reason: 'http' };
        issues.push(summary);
      }
      const next = nextPageFromLink(got.value.res.headers.get('link'));
      // Link が無くても満杯なら続きがあるものとして読む（取りこぼすより多く読む）
      const page: IssueListPage = {
        issues,
        nextPage: next ?? (got.value.json.length >= input.perPage ? input.page + 1 : null),
      };
      return { ok: true, value: page };
    },
  };
}
