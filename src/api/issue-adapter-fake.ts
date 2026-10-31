/**
 * IssueAdapter のメモリ上の fake（試験・ローカル確認専用）。ネットワークを使わない。production では作れない。
 * 実 GitHub と同じ分類の結果を返せるよう、次の送信の結果を差し込める。
 */
import type { IssueAdapter, IssueSendOutcome, IssueSummary, IssueWriteInput } from '../shared/devline.js';

export interface FakeIssue extends IssueSummary {
  title: string;
  repo: string;
}

export interface FakeIssueAdapter extends IssueAdapter {
  readonly issues: FakeIssue[];
  readonly calls: { method: string; repo?: string; issueNo?: number }[];
  /** 次の送信の結果を差し替える。`createThenLose` は作ったうえで応答を失う（unknown）。 */
  failNextSend(outcome: IssueSendOutcome | 'createThenLose'): void;
}

export function createFakeIssueAdapter(
  options: {
    actorLogin?: string;
    repoIds?: Readonly<Record<string, string>>;
    baseSha?: string;
    /** 外部へ送る瞬間に呼ぶ。送信の前に commit 済みかを確かめる試験に使う。 */
    beforeSend?: (input: IssueWriteInput) => void | Promise<void>;
  } = {},
): FakeIssueAdapter {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('fake の IssueAdapter は production では使えません');
  }
  const actorLogin = options.actorLogin ?? 'msf-fake-bot';
  const baseSha = options.baseSha ?? 'a'.repeat(40);
  const issues: FakeIssue[] = [];
  const calls: FakeIssueAdapter['calls'] = [];
  const pending: (IssueSendOutcome | 'createThenLose')[] = [];
  let nextNumber = 1;

  const makeIssue = (input: IssueWriteInput): FakeIssue => {
    const number = nextNumber;
    nextNumber += 1;
    const issue: FakeIssue = {
      number,
      url: `https://github.invalid/${input.repo}/issues/${number}`,
      body: input.body,
      authorLogin: actorLogin,
      isPullRequest: false,
      title: input.title,
      repo: input.repo,
    };
    issues.push(issue);
    return issue;
  };

  return {
    kind: 'fake',
    issues,
    calls,
    failNextSend(outcome) {
      pending.push(outcome);
    },
    async getActorLogin() {
      calls.push({ method: 'getActorLogin' });
      return { ok: true, value: actorLogin };
    },
    async getRepoId(repo) {
      calls.push({ method: 'getRepoId', repo });
      const id = options.repoIds?.[repo];
      return id ? { ok: true, value: id } : { ok: false, reason: 'http', httpStatus: 404 };
    },
    async resolveBaseSha(repo) {
      calls.push({ method: 'resolveBaseSha', repo });
      return { ok: true, value: baseSha };
    },
    async createIssue(input) {
      calls.push({ method: 'createIssue', repo: input.repo });
      await options.beforeSend?.(input);
      const injected = pending.shift();
      if (injected === 'createThenLose') {
        makeIssue(input);
        return { outcome: 'unknown', reason: 'network' };
      }
      if (injected) return injected;
      const issue = makeIssue(input);
      return { outcome: 'succeeded', number: issue.number, url: issue.url };
    },
    async updateIssue(input) {
      calls.push({ method: 'updateIssue', repo: input.repo, issueNo: input.issueNo });
      await options.beforeSend?.(input);
      const injected = pending.shift();
      const issue = issues.find((i) => i.number === input.issueNo && i.repo === input.repo);
      if (injected === 'createThenLose') {
        if (issue) issue.body = input.body;
        return { outcome: 'unknown', reason: 'network' };
      }
      if (injected) return injected;
      if (!issue) return { outcome: 'failed', reason: 'http_4xx', httpStatus: 404 };
      issue.body = input.body;
      issue.title = input.title;
      return { outcome: 'succeeded', number: issue.number, url: issue.url };
    },
    async getIssue(repo, issueNo) {
      calls.push({ method: 'getIssue', repo, issueNo });
      return { ok: true, value: issues.find((i) => i.number === issueNo && i.repo === repo) ?? null };
    },
    async listIssuesSince(input) {
      calls.push({ method: 'listIssuesSince', repo: input.repo });
      const start = (input.page - 1) * input.perPage;
      const inRepo = issues.filter((i) => i.repo === input.repo);
      return {
        ok: true,
        value: {
          issues: inRepo.slice(start, start + input.perPage),
          nextPage: start + input.perPage < inRepo.length ? input.page + 1 : null,
        },
      };
    },
  };
}
