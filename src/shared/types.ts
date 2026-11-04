import type { Decides, FrequencyKey, Kind, Party, Role, Signal, Status, Tailoring } from './domain.js';

export interface RequestRecord {
  id: string;
  seq: number;
  year: number;
  createdAt: string;
  updatedAt: string;
  applicant: string;
  applicantUserId?: string | null;
  deptCode: string;
  deptName?: string;
  contact?: string | null;
  title: string;
  kind: Kind;
  toolId?: string | null;
  toolName?: string | null;
  problem: string;
  purpose: string;
  users: string[];
  people?: number | null;
  places: string[];
  scope: string[];
  outOfScope: string[];
  criteria: string[];
  decides: Decides;
  dataHandling: string[];
  parties: Party;
  constraints: string[];
  constraintsOther: string[];
  approvals: string[];
  frequency?: FrequencyKey | null;
  minutesPerTime?: number | null;
  dataReady?: number | null;
  spread?: number | null;
  wishDate?: string | null;
  approver: string;
  approverUserId?: string | null;
  status: Status;
  signalDecided?: Signal | null;
  tailoring?: Tailoring | null;
  orderVersion: number;
  version: number;
  deleted: boolean;
  issueNo?: number | null;
  /** 依頼ごとの開発ラインの投入先（`owner/name`）。null は未指定（既定＝DEVLINE_TARGET_REPOS の先頭）。 */
  targetRepoId?: string | null;
  history?: HistoryEntry[];
  comments?: CommentEntry[];
}

export interface HistoryEntry {
  id: number;
  at: string;
  actorName: string;
  actorUserId?: string | null;
  role: Role | 'system';
  action: string;
  note?: string | null;
  correlationId?: string | null;
}

export interface CommentEntry {
  id: number;
  at: string;
  by: string;
  text: string;
}

export interface ApprovalEntry {
  id: string;
  at: string;
  approver: string;
  decision: 'approved' | 'returned' | 'held';
  reason?: string | null;
  decidedSignal?: Signal | null;
  suggestedSignal?: Signal | null;
  checklist: unknown;
  orderVersion: number;
}

export interface RequestDetail extends RequestRecord {
  suggested: { color: Signal; reasons: string[] };
  measure: number;
  score: { key: string; label: string; score: number }[];
  staleDays: number;
  staleLevel: 'ok' | 'warn' | 'danger';
  yourTurn: { target: boolean; action: string };
  transitions: { to: Status; allowed: boolean; reason?: string; who?: Role; requiresReason?: boolean }[];
  criteriaChecks: { text: string; kind: string; message: string; vagueWords: string[]; rewrites: unknown[] }[];
  approverIsMe: boolean;
  isOwner: boolean;
  /** 承認依頼メールの最新状態（まだ送っていなければ null） */
  mail: {
    id: string;
    status: 'pending' | 'sending' | 'sent' | 'failed';
    to: string;
    sentAt: string | null;
    lastError: string | null;
    attempts: number;
  } | null;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  deptCode: string;
  isAdmin: boolean;
  roles: Role[];
  actingRole: Role;
}

export interface RequestSummary extends RequestRecord {
  suggested: Signal;
  measure: number;
  staleDays: number;
  staleLevel: 'ok' | 'warn' | 'danger';
  yourTurn: { target: boolean; action: string };
  nextBy?: Role;
  approverIsMe: boolean;
}

export interface HomeResponse {
  role: Role;
  counts: {
    yourTurn: number;
    waitingApproval: number;
    stale3: number;
    total: number;
    draft: boolean;
  };
  yourTurn: RequestSummary[];
  staleOthers: RequestSummary[];
  myRequests: RequestSummary[];
  recent: HistoryEntry[];
}

export interface ListResponse {
  items: RequestSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DepartmentRow {
  code: string;
  name: string;
  shortName: string;
  roleDesc: string;
  sortOrder: number;
  toolCount: number;
  g: number;
  y: number;
  r: number;
}

export interface CatalogTool {
  id: string;
  deptCode: string;
  deptName: string;
  name: string;
  description: string;
  signal: Signal;
  seedCandidate: boolean;
  sortOrder: number;
}

export interface MetaResponse {
  appName: string;
  version: string;
  commit: string;
  environment: string;
  now: string;
  staleWarnDays: number;
  staleDangerDays: number;
  allowSelfApproval: boolean;
  allowImport: boolean;
  authMode: 'password' | 'access';
  githubConfigured: boolean;
  approvers: { name: string; email: string }[];
}
