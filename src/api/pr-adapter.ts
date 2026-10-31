/**
 * PR の GitHub 実装（issue-adapter.ts と同じ流儀）。
 * 冪等性はここでは作らない。結果の分類だけを行い、呼び出し側がマーカーで照合する。
 * merge と Approve の口を持たない（AI は merge しない。Approve しない）。
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
