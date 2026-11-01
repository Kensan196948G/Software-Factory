/**
 * 試験用のローカル fake GitHub（OS 割当ポート）。実 GitHub へ送らない。
 * 実アダプタ（src/api/issue-adapter.ts）をこのサーバへ向けて、順序・照合・ページ送りを確かめる。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeGithubIssue {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  html_url: string;
  pull_request?: unknown;
}

export interface FakeAccess {
  method: string;
  path: string;
  query: string;
  authorization: string | undefined;
}

export type FakeResponder = (req: { method: string; path: string; body: any }) => FakeReply | null | Promise<FakeReply | null>;
export interface FakeReply {
  status: number;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  /** 処理したうえで接続を切る（応答の喪失）。 */
  destroy?: boolean;
}

/** merge の経路の試験用の PR。tree は commit の SHA ごとの tree の SHA。 */
export interface FakeGithubPull {
  number: number;
  head: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeSha: string | null;
  /** 次の merge の応答を変える（既定は成功）。 */
  mergeReply?: FakeReply | null;
}

export interface FakeGithub {
  url: string;
  pulls: FakeGithubPull[];
  trees: Record<string, string>;
  access: FakeAccess[];
  issues: FakeGithubIssue[];
  /** 順番に1回ずつ使う上書き。null を返すと通常の処理へ。 */
  overrides: FakeResponder[];
  /** 通常の作成の直前に呼ぶ（commit 済みの確認用）。 */
  onWrite: ((body: any) => void | Promise<void>) | null;
  /** GET /repos の private。既定は true。false で公開リポジトリを模す。 */
  repoPrivate: boolean;
  addForeignIssue(issue: Partial<FakeGithubIssue> & { body: string; login: string }): FakeGithubIssue;
  close(): Promise<void>;
}

export const FAKE_REPO = 'msf-test/fake-repo';
export const FAKE_REPO_ID = '4242';
export const FAKE_LOGIN = 'msf-fake-bot';
export const FAKE_BASE_SHA = 'b'.repeat(40);

export async function startFakeGithub(): Promise<FakeGithub> {
  const access: FakeAccess[] = [];
  const issues: FakeGithubIssue[] = [];
  const overrides: FakeResponder[] = [];
  const pulls: FakeGithubPull[] = [];
  const trees: Record<string, string> = {};
  let mergeCounter = 0;
  let nextNumber = 100;
  let baseUrl = '';
  const state: { onWrite: FakeGithub['onWrite']; repoPrivate: boolean } = { onWrite: null, repoPrivate: true };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage): Promise<any> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : null;
  };
  const repoPrefix = `/repos/${FAKE_REPO}`;
  const newIssue = (title: string, body: string | null, login: string): FakeGithubIssue => {
    const number = nextNumber;
    nextNumber += 1;
    const issue = { number, title, body, user: { login }, html_url: `${baseUrl}/${FAKE_REPO}/issues/${number}` };
    issues.push(issue);
    return issue;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://local');
      const method = req.method ?? 'GET';
      const path = url.pathname;
      const body = await readBody(req);
      access.push({ method, path, query: url.search, authorization: req.headers.authorization });

      const override = overrides.shift();
      const reply = override ? await override({ method, path, body }) : null;
      if (reply) {
        if (reply.destroy) {
          res.destroy();
          return;
        }
        res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
        res.end(reply.rawBody ?? JSON.stringify(reply.body ?? {}));
        return;
      }

      if (method === 'GET' && path === '/user') return send(res, 200, { login: FAKE_LOGIN });
      if (method === 'GET' && path === repoPrefix) {
        return send(res, 200, { id: Number(FAKE_REPO_ID), default_branch: 'main', private: state.repoPrivate });
      }
      if (method === 'GET' && path === `${repoPrefix}/commits/main`) return send(res, 200, { sha: FAKE_BASE_SHA });
      if (method === 'POST' && path === `${repoPrefix}/issues`) {
        await state.onWrite?.(body);
        return send(res, 201, newIssue(body.title, body.body, FAKE_LOGIN));
      }
      const single = new RegExp(`^${repoPrefix}/issues/(\\d+)$`).exec(path);
      if (single) {
        const issue = issues.find((i) => i.number === Number(single[1]));
        if (!issue) return send(res, 404, { message: 'Not Found' });
        if (method === 'GET') return send(res, 200, issue);
        if (method === 'PATCH') {
          await state.onWrite?.(body);
          issue.title = body.title;
          issue.body = body.body;
          return send(res, 200, issue);
        }
      }
      const pullOne = new RegExp(`^${repoPrefix}/pulls/(\\d+)(/merge)?$`).exec(path);
      if (pullOne) {
        const pull = pulls.find((p) => p.number === Number(pullOne[1]));
        if (!pull) return send(res, 404, { message: 'Not Found' });
        const json = {
          number: pull.number,
          html_url: `${baseUrl}/${FAKE_REPO}/pull/${pull.number}`,
          body: pull.body,
          state: pull.state,
          merged: pull.merged,
          merge_commit_sha: pull.mergeSha,
          user: { login: FAKE_LOGIN },
          head: { sha: pull.head, ref: `msf/${pull.number}`, repo: { full_name: FAKE_REPO } },
          base: { ref: 'main' },
        };
        if (!pullOne[2] && method === 'GET') return send(res, 200, json);
        if (pullOne[2] && method === 'PUT') {
          if (pull.mergeReply) {
            const reply = pull.mergeReply;
            pull.mergeReply = null;
            return send(res, reply.status, reply.body ?? {});
          }
          if (body?.sha !== pull.head) return send(res, 409, { message: 'Head branch was modified' });
          if (body?.merge_method !== 'squash') return send(res, 405, { message: 'squash only' });
          mergeCounter += 1;
          pull.merged = true;
          pull.state = 'closed';
          pull.mergeSha = String(mergeCounter).padStart(40, '7');
          trees[pull.mergeSha] = trees[pull.head] ?? 'e'.repeat(40);
          return send(res, 200, { merged: true, sha: pull.mergeSha, message: 'merged' });
        }
      }
      // base の最新を含むか。試験は既定で遅れなし
      if (method === 'GET' && new RegExp(`^${repoPrefix}/compare/[^/]+\\.\\.\\.[0-9a-f]{40}$`).test(path)) {
        return send(res, 200, { behind_by: 0, ahead_by: 1, status: 'ahead' });
      }
      const commitOne = new RegExp(`^${repoPrefix}/git/commits/([0-9a-f]{40})$`).exec(path);
      if (commitOne && method === 'GET') {
        const tree = trees[commitOne[1] as string];
        return tree ? send(res, 200, { sha: commitOne[1], tree: { sha: tree } }) : send(res, 404, { message: 'Not Found' });
      }
      if (method === 'GET' && path === `${repoPrefix}/issues`) {
        const page = Number(url.searchParams.get('page') ?? 1);
        const perPage = Number(url.searchParams.get('per_page') ?? 30);
        const start = (page - 1) * perPage;
        const headers: Record<string, string> =
          start + perPage < issues.length ? { link: `<${baseUrl}${path}?page=${page + 1}>; rel="next"` } : {};
        return send(res, 200, issues.slice(start, start + perPage), headers);
      }
      return send(res, 404, { message: 'Not Found' });
    })().catch(() => res.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: baseUrl,
    pulls,
    trees,
    access,
    issues,
    overrides,
    get onWrite() {
      return state.onWrite;
    },
    set onWrite(fn) {
      state.onWrite = fn;
    },
    get repoPrivate() {
      return state.repoPrivate;
    },
    set repoPrivate(value) {
      state.repoPrivate = value;
    },
    addForeignIssue({ body, login, ...rest }) {
      const issue = newIssue(rest.title ?? 'foreign', body, login);
      if (rest.pull_request !== undefined) issue.pull_request = rest.pull_request;
      return issue;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
