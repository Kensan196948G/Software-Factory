import { config } from './config.js';
import { ApiError } from './http.js';

export interface GitHubIssueResult {
  number: number;
  url: string;
}

function apiBase(): string {
  return process.env.GITHUB_API_URL ?? 'https://api.github.com';
}

export function isGithubConfigured(): boolean {
  return Boolean(config.githubToken && config.githubRepo);
}

/**
 * 承認済み注文書から GitHub Issue を作る（FR-28・API-06）。
 * 冪等性は `request.issue_no` で担保する（呼び出し側が既存番号を確認する）。
 */
export async function createIssue(input: {
  requestId: string;
  title: string;
  orderYaml: string;
  approver: string;
  signalLabel: string;
  deptLabel: string;
  tailoring?: string | null;
  previewUrl?: string;
}): Promise<GitHubIssueResult> {
  if (!config.githubToken) {
    throw new ApiError('ERR-405', 'GitHub連携が設定されていません（管理者に確認してください）', 409);
  }
  const [owner, repo] = config.githubRepo.split('/');
  if (!owner || !repo) {
    throw new ApiError('ERR-405', 'GITHUB_REPO の設定が正しくありません', 500);
  }

  const body = [
    `## 受付からの注文書（${input.requestId}）`,
    '',
    `- 承認者: ${input.approver}`,
    `- 信号: ${input.signalLabel}`,
    `- 部署: ${input.deptLabel}`,
    `- 型: ${input.tailoring ?? '未設定'}`,
    ...(input.previewUrl ? [`- 受付: ${input.previewUrl}`] : []),
    '',
    '### 注文書 YAML（承認時の版）',
    '',
    '```yaml',
    input.orderYaml.trimEnd(),
    '```',
    '',
    '> このIssueは受付ステーションが自動作成しました。実装は別途、人の承認を経て行います。',
  ].join('\n');

  let res: Response;
  try {
    res = await fetch(`${apiBase()}/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.githubToken}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'mirai-sf-intake',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ title: input.title, body }),
    });
  } catch (err) {
    throw new ApiError('ERR-304', `GitHubに接続できませんでした（${(err as Error).message}）`, 502);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError('ERR-304', `GitHubに接続できませんでした（${res.status}）`, 502, { detail: text.slice(0, 300) });
  }
  const issue = (await res.json()) as { number: number; html_url: string };
  return { number: issue.number, url: issue.html_url };
}
