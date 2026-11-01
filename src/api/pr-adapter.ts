/**
 * PR の GitHub 実装（issue-adapter.ts と同じ流儀）。
 * 冪等性はここでは作らない。結果の分類だけを行い、呼び出し側がマーカーで照合する。
 * PrAdapter は merge と Approve の口を持たない（AI は merge しない。Approve しない）。
 * merge は別の口（PrMergeAdapter）で、人の承認の経路（src/api/devline-release.ts）だけが作る。
 * worker と runner からは import しない（試験で固定している）。
 * 応答の全文や header は保存しない。token はこのファイルの外へ出さない。
 */
import { classifyIssueResponse } from '../shared/devline.js';
import type { IssueReadResult, IssueTransportFacts } from '../shared/devline.js';
import { ApiError } from './http.js';
import { assertApiUrlAllowed, type GithubAdapterOptions } from './issue-adapter.js';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface PullSummary {
  number: number;
  url: string;
  body: string | null;
  authorLogin: string | null;
  headSha: string | null;
  headRef: string | null;
  headRepo: string | null;
  state: string | null;
}

export type PullSendOutcome =
  | { outcome: 'succeeded'; pull: PullSummary }
  | { outcome: 'unknown'; reason: 'timeout' | 'network' | 'http' | 'bad_response'; httpStatus?: number }
  | { outcome: 'failed'; reason: 'http_4xx'; httpStatus: number; alreadyExists: boolean }
  | { outcome: 'rate_limited'; httpStatus: number };

export interface PrAdapter {
  createPull(
    input: { repo: string; title: string; body: string; head: string; base: string },
    signal: AbortSignal,
  ): Promise<PullSendOutcome>;
  updatePullBody(input: { repo: string; number: number; body: string }, signal: AbortSignal): Promise<PullSendOutcome>;
  closePull(input: { repo: string; number: number }, signal: AbortSignal): Promise<PullSendOutcome>;
  /** head のブランチで絞ったリスト（state=all）。search API を使わない。 */
  listPullsByHead(input: { repo: string; branch: string }, signal: AbortSignal): Promise<IssueReadResult<PullSummary[]>>;
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

function toPull(raw: unknown): PullSummary | null {
  const pr = raw as {
    number?: unknown;
    html_url?: unknown;
    body?: unknown;
    state?: unknown;
    user?: { login?: unknown } | null;
    head?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } | null } | null;
  } | null;
  if (!pr || !Number.isInteger(pr.number) || typeof pr.html_url !== 'string') return null;
  return {
    number: pr.number as number,
    url: pr.html_url,
    body: typeof pr.body === 'string' ? pr.body : null,
    authorLogin: typeof pr.user?.login === 'string' ? pr.user.login : null,
    headSha: typeof pr.head?.sha === 'string' ? pr.head.sha : null,
    headRef: typeof pr.head?.ref === 'string' ? pr.head.ref : null,
    headRepo: typeof pr.head?.repo?.full_name === 'string' ? pr.head.repo.full_name : null,
    state: typeof pr.state === 'string' ? pr.state : null,
  };
}

export function createGithubPrAdapter(options: GithubAdapterOptions): PrAdapter {
  const base = assertApiUrlAllowed(options.apiUrl, options.nodeEnv).toString().replace(/\/$/, '');
  const headers = (json: boolean): Record<string, string> => ({
    authorization: `Bearer ${options.token}`,
    accept: 'application/vnd.github+json',
    ...(json ? { 'content-type': 'application/json' } : {}),
    'user-agent': 'mirai-sf-devline',
    'x-github-api-version': '2022-11-28',
  });

  async function write(method: 'POST' | 'PATCH', path: string, payload: unknown, signal: AbortSignal): Promise<PullSendOutcome> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: headers(true),
        body: JSON.stringify(payload),
        signal,
        redirect: 'manual',
      });
    } catch (err) {
      return { outcome: 'unknown', reason: isAbortLike(err) ? 'timeout' : 'network' };
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch (err) {
      if (isAbortLike(err)) return { outcome: 'unknown', reason: 'timeout', httpStatus: res.status };
    }
    const pull = toPull(parsed);
    const facts: IssueTransportFacts = {
      kind: 'http',
      status: res.status,
      bodyParsed: pull !== null,
      retryAfterPresent: res.headers.get('retry-after') !== null,
      rateLimitExhausted: res.headers.get('x-ratelimit-remaining') === '0',
    };
    const outcome = classifyIssueResponse(facts);
    if (outcome === 'succeeded') return { outcome, pull: pull as PullSummary };
    if (outcome === 'rate_limited') return { outcome, httpStatus: res.status };
    if (outcome === 'failed') {
      // 同じ head の PR がすでにある（422）は、応答を失った作成の再送で起きる
      const text = JSON.stringify(parsed ?? '').toLowerCase();
      return {
        outcome,
        reason: 'http_4xx',
        httpStatus: res.status,
        alreadyExists: res.status === 422 && text.includes('already exists'),
      };
    }
    return { outcome: 'unknown', reason: res.ok ? 'bad_response' : 'http', httpStatus: res.status };
  }

  return {
    createPull(input, signal) {
      return write(
        'POST',
        `${repoPath(input.repo)}/pulls`,
        { title: input.title, body: input.body, head: input.head, base: input.base, maintainer_can_modify: false },
        signal,
      );
    },

    updatePullBody(input, signal) {
      return write('PATCH', `${repoPath(input.repo)}/pulls/${input.number}`, { body: input.body }, signal);
    },

    closePull(input, signal) {
      return write('PATCH', `${repoPath(input.repo)}/pulls/${input.number}`, { state: 'closed' }, signal);
    },

    async listPullsByHead(input, signal) {
      const owner = input.repo.split('/')[0] ?? '';
      const params = new URLSearchParams({ state: 'all', head: `${owner}:${input.branch}`, per_page: '100' });
      let res: Response;
      try {
        res = await fetch(`${base}${repoPath(input.repo)}/pulls?${params.toString()}`, {
          method: 'GET',
          headers: headers(false),
          signal,
          redirect: 'manual',
        });
      } catch (err) {
        return { ok: false, reason: isAbortLike(err) ? 'timeout' : 'network' };
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, reason: 'http', httpStatus: res.status };
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        return isAbortLike(err) ? { ok: false, reason: 'timeout' } : { ok: false, reason: 'http', httpStatus: res.status };
      }
      if (!Array.isArray(json)) return { ok: false, reason: 'http' };
      const pulls: PullSummary[] = [];
      for (const raw of json) {
        const pull = toPull(raw);
        if (!pull) return { ok: false, reason: 'http' };
        pulls.push(pull);
      }
      return { ok: true, value: pulls };
    },
  };
}

/* ───────────────────────────── merge（人の承認の経路だけ） ───────────────────────────── */

export interface PullMergeFacts {
  number: number;
  url: string;
  state: string | null;
  merged: boolean;
  mergeSha: string | null;
  headSha: string | null;
  baseRef: string | null;
  authorLogin: string | null;
  body: string | null;
}

export type MergeSendOutcome =
  | { outcome: 'merged'; mergeSha: string }
  /** 届いたか分からない。送り直さず、PR を読んで照合する。 */
  | { outcome: 'unknown'; reason: 'timeout' | 'network' | 'http' | 'bad_response'; httpStatus?: number }
  /** 409: 渡した sha と head が違う。405: merge できない（検査・競合・保護）。 */
  | { outcome: 'rejected'; cause: 'head_changed' | 'not_mergeable' | 'refused' | 'rate_limited'; httpStatus: number };

export interface PrMergeAdapter {
  getActorLogin(signal: AbortSignal): Promise<IssueReadResult<string>>;
  getDefaultBranch(repo: string, signal: AbortSignal): Promise<IssueReadResult<string>>;
  getPull(input: { repo: string; number: number }, signal: AbortSignal): Promise<IssueReadResult<PullMergeFacts | null>>;
  /** commit の tree の SHA。無ければ null。 */
  getCommitTree(input: { repo: string; sha: string }, signal: AbortSignal): Promise<IssueReadResult<string | null>>;
  /** squash で merge する。sha を必ず渡すので、head が変わっていれば GitHub が拒否する。 */
  mergePull(input: { repo: string; number: number; sha: string; title: string }, signal: AbortSignal): Promise<MergeSendOutcome>;
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** merge の口を作る。呼んでよいのは src/api/devline-release.ts だけ。 */
export function createGithubPrMergeAdapter(options: GithubAdapterOptions): PrMergeAdapter {
  const base = assertApiUrlAllowed(options.apiUrl, options.nodeEnv).toString().replace(/\/$/, '');
  const headers = (json: boolean): Record<string, string> => ({
    authorization: `Bearer ${options.token}`,
    accept: 'application/vnd.github+json',
    ...(json ? { 'content-type': 'application/json' } : {}),
    'user-agent': 'mirai-sf-devline',
    'x-github-api-version': '2022-11-28',
  });

  async function read<T>(
    path: string,
    signal: AbortSignal,
    parse: (json: unknown) => T | undefined,
  ): Promise<IssueReadResult<T | null>> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { method: 'GET', headers: headers(false), signal, redirect: 'manual' });
    } catch (err) {
      return { ok: false, reason: isAbortLike(err) ? 'timeout' : 'network' };
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: true, value: null };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'http', httpStatus: res.status };
    }
    try {
      const value = parse(await res.json());
      return value === undefined ? { ok: false, reason: 'http', httpStatus: res.status } : { ok: true, value };
    } catch (err) {
      return isAbortLike(err) ? { ok: false, reason: 'timeout' } : { ok: false, reason: 'http', httpStatus: res.status };
    }
  }

  const required = <T>(result: IssueReadResult<T | null>): IssueReadResult<T> => {
    if (!result.ok) return result;
    return result.value === null ? { ok: false, reason: 'http', httpStatus: 404 } : { ok: true, value: result.value };
  };

  return {
    async getActorLogin(signal) {
      return required(
        await read('/user', signal, (json) => {
          const login = (json as { login?: unknown } | null)?.login;
          return typeof login === 'string' ? login : undefined;
        }),
      );
    },

    async getDefaultBranch(repo, signal) {
      return required(
        await read(repoPath(repo), signal, (json) => {
          const branch = (json as { default_branch?: unknown } | null)?.default_branch;
          return typeof branch === 'string' ? branch : undefined;
        }),
      );
    },

    getPull(input, signal) {
      return read(`${repoPath(input.repo)}/pulls/${input.number}`, signal, (json) => {
        const pull = toPull(json);
        if (!pull) return undefined;
        const raw = json as { merged?: unknown; merge_commit_sha?: unknown; base?: { ref?: unknown } | null };
        return {
          number: pull.number,
          url: pull.url,
          state: pull.state,
          merged: raw.merged === true,
          mergeSha: typeof raw.merge_commit_sha === 'string' && SHA_RE.test(raw.merge_commit_sha) ? raw.merge_commit_sha : null,
          headSha: pull.headSha,
          baseRef: typeof raw.base?.ref === 'string' ? raw.base.ref : null,
          authorLogin: pull.authorLogin,
          body: pull.body,
        };
      });
    },

    getCommitTree(input, signal) {
      if (!SHA_RE.test(input.sha)) throw new ApiError('ERR-405', 'SHA の形が正しくありません', 409);
      return read(`${repoPath(input.repo)}/git/commits/${input.sha}`, signal, (json) => {
        const tree = (json as { tree?: { sha?: unknown } | null } | null)?.tree?.sha;
        return typeof tree === 'string' && SHA_RE.test(tree) ? tree : undefined;
      });
    },

    async mergePull(input, signal) {
      if (!SHA_RE.test(input.sha)) throw new ApiError('ERR-405', 'SHA の形が正しくありません', 409);
      let res: Response;
      try {
        res = await fetch(`${base}${repoPath(input.repo)}/pulls/${input.number}/merge`, {
          method: 'PUT',
          headers: headers(true),
          body: JSON.stringify({ merge_method: 'squash', sha: input.sha, commit_title: input.title }),
          signal,
          redirect: 'manual',
        });
      } catch (err) {
        return { outcome: 'unknown', reason: isAbortLike(err) ? 'timeout' : 'network' };
      }
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch (err) {
        if (isAbortLike(err)) return { outcome: 'unknown', reason: 'timeout', httpStatus: res.status };
      }
      if (res.ok) {
        const done = parsed as { merged?: unknown; sha?: unknown } | null;
        if (done?.merged === true && typeof done.sha === 'string' && SHA_RE.test(done.sha)) {
          return { outcome: 'merged', mergeSha: done.sha };
        }
        return { outcome: 'unknown', reason: 'bad_response', httpStatus: res.status };
      }
      if (res.status === 409) return { outcome: 'rejected', cause: 'head_changed', httpStatus: 409 };
      if (res.status === 405) return { outcome: 'rejected', cause: 'not_mergeable', httpStatus: 405 };
      if (res.status === 429) return { outcome: 'rejected', cause: 'rate_limited', httpStatus: 429 };
      if (res.status >= 500) return { outcome: 'unknown', reason: 'http', httpStatus: res.status };
      if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
        return { outcome: 'rejected', cause: 'rate_limited', httpStatus: 403 };
      }
      return { outcome: 'rejected', cause: 'refused', httpStatus: res.status };
    },
  };
}
