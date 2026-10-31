import { config } from './config.js';

export function isGithubConfigured(): boolean {
  return Boolean(config.githubToken && config.githubRepo);
}

/**
 * 利用者の値をインラインコードにする。1行に潰し、値より長い backtick で囲むので、
 * メンション・リンク・見出し・HTML コメントとして解釈されない。
 */
export function inlineCode(value: unknown): string {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return '`（なし）`';
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Issue のタイトル。コードにできないので、通知やリンクになる文字を全角へ置きかえて1行にする。 */
export function safeIssueTitle(requestId: string, title: string): string {
  const flat = title
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/@/g, '＠')
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .replace(/`/g, '｀');
  return `[MSF] ${requestId} ${flat}`.slice(0, 200);
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
    `- 承認者: ${inlineCode(input.approver)}`,
    `- 信号: ${inlineCode(input.signalLabel)}`,
    `- 部署: ${inlineCode(input.deptLabel)}`,
    `- 型: ${inlineCode(input.tailoring ?? '未設定')}`,
    ...(input.previewUrl ? [`- 受付: ${inlineCode(input.previewUrl)}`] : []),
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
