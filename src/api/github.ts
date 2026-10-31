import { config } from './config.js';

export function isGithubConfigured(): boolean {
  return Boolean(config.githubToken && config.githubRepo);
}

/** Issue 本文（FR-28・仕様 6-4）。1行目は照合用のマーカー。YAML は固定した本文をそのまま使う。 */
export function buildIssueBody(input: {
  marker: string;
  requestId: string;
  orderYaml: string;
  approver: string;
  signalLabel: string;
  deptLabel: string;
  tailoring?: string | null;
  previewUrl?: string;
}): string {
  // 注文書の文章に ``` があってもコードブロックを閉じさせない
  const longestRun = Math.max(2, ...(input.orderYaml.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  return [
    input.marker,
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
    `${fence}yaml`,
    input.orderYaml.trimEnd(),
    fence,
    '',
    '> このIssueは受付ステーションが自動作成しました。実装は別途、人の承認を経て行います。',
  ].join('\n');
}
