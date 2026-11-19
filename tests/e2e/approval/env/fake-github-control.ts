/**
 * 層①の偽 GitHub。tests/integration/fake-github-server.ts をそのまま使い、
 * E2E から PR を差し込める小さな制御 API を同じプロセスに足す（実 GitHub へは送らない）。
 * 偽サーバ本体の URL は API プロセスへ、制御 API の URL は Playwright へ渡す。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  FAKE_BASE_SHA,
  FAKE_REPO,
  FAKE_REPO_ID,
  startFakeGithub,
  type FakeGithub,
  type FakeGithubPull,
} from '../../../integration/fake-github-server';

export { FAKE_BASE_SHA, FAKE_REPO, FAKE_REPO_ID };

export interface FakeControl {
  github: FakeGithub;
  controlUrl: string;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export async function startFakeGithubWithControl(): Promise<FakeControl> {
  const github = await startFakeGithub();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://local');
      const method = req.method ?? 'GET';
      if (method === 'GET' && url.pathname === '/__ctl/state') {
        return send(res, 200, {
          repo: FAKE_REPO,
          repoId: FAKE_REPO_ID,
          baseSha: FAKE_BASE_SHA,
          url: github.url,
          issues: github.issues,
          pulls: github.pulls,
        });
      }
      if (method === 'POST' && url.pathname === '/__ctl/pull') {
        const body = (await readBody(req)) as {
          number?: number;
          head?: string;
          body?: string;
          state?: 'open' | 'closed';
          merged?: boolean;
          trees?: Record<string, string>;
        };
        if (!body || !Number.isInteger(body.number) || !/^[0-9a-f]{40}$/.test(body.head ?? '')) {
          return send(res, 400, { error: 'number (int) と head (40 hex) が必要です' });
        }
        const pull: FakeGithubPull = {
          number: body.number as number,
          head: body.head as string,
          body: body.body ?? '',
          state: body.state ?? 'open',
          merged: body.merged ?? false,
          mergeSha: null,
        };
        const existing = github.pulls.findIndex((p) => p.number === pull.number);
        if (existing >= 0) github.pulls.splice(existing, 1, pull);
        else github.pulls.push(pull);
        Object.assign(github.trees, body.trees ?? {});
        return send(res, 200, pull);
      }
      if (method === 'POST' && url.pathname === '/__ctl/issue') {
        const body = (await readBody(req)) as { title?: string; body?: string; login?: string };
        if (!body?.body) return send(res, 400, { error: 'body が必要です' });
        const issue = github.addForeignIssue({
          title: body.title ?? 'foreign',
          body: body.body,
          login: body.login ?? 'other-user',
        });
        return send(res, 200, issue);
      }
      return send(res, 404, { error: 'not found' });
    })().catch((error: unknown) => send(res, 500, { error: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const controlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    github,
    controlUrl,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await github.close();
    },
  };
}
