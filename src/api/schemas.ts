import { z } from 'zod';
import {
  APPROVALS,
  CONSTRAINTS,
  DATA_HANDLING,
  FREQUENCIES,
  KINDS,
  PARTIES,
  PLACES,
  SIGNALS,
  STATUSES,
  TAILORING,
  USERS,
} from '../shared/domain.js';

const nonEmpty = (max = 2000) => z.string().trim().min(1).max(max);
const lineList = (max = 2000) => z.array(z.string().trim().min(1).max(max)).max(50);

export const requestInputSchema = z.object({
  clientId: z
    .string()
    .regex(/^REQ-\d{4}-\d{4}$/)
    .optional(),
  title: z.string().trim().min(1, '件名を入れてください').max(60, '件名は60文字までです'),
  kind: z.enum(KINDS),
  deptCode: z.string().trim().min(1),
  applicant: z.string().trim().min(1).max(80),
  contact: z.string().trim().max(255).optional().nullable(),
  toolId: z.string().trim().max(40).optional().nullable(),
  problem: nonEmpty(2000),
  purpose: nonEmpty(2000),
  users: z.array(z.enum(USERS)).min(1, 'だれが使う？を1つ以上選んでください'),
  people: z.number().int().min(0).max(100000).optional().nullable(),
  places: z.array(z.enum(PLACES)).max(5).default([]),
  scope: lineList(500).min(1, '作るものを1つ以上入れてください'),
  outOfScope: lineList(500).default([]),
  criteria: z
    .array(z.string().trim().max(500))
    .min(1, '合格の条件を1つ以上入れてください')
    .max(8, '合格の条件は8件までです')
    .refine((arr) => arr.some((c) => c.trim() !== ''), '合格の条件を1つ以上入れてください'),
  decides: z.enum(['g', 'y', 'r']),
  dataHandling: z.array(z.enum(DATA_HANDLING.map((d) => d.key) as [string, ...string[]])).default([]),
  parties: z.enum(PARTIES).default('internal'),
  constraints: z.array(z.enum(CONSTRAINTS)).default([]),
  constraintsOther: lineList(500).default([]),
  approvals: z.array(z.enum(APPROVALS)).default([]),
  frequency: z
    .enum(FREQUENCIES.map((f) => f.key) as [string, ...string[]])
    .optional()
    .nullable(),
  minutesPerTime: z.number().int().min(0).max(100000).optional().nullable(),
  dataReady: z
    .union([z.literal(1), z.literal(3), z.literal(5)])
    .optional()
    .nullable(),
  spread: z
    .union([z.literal(1), z.literal(3), z.literal(5)])
    .optional()
    .nullable(),
  wishDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日付の形が正しくありません')
    .optional()
    .nullable(),
  approver: z.string().trim().min(1).max(80),
});

export type RequestInput = z.infer<typeof requestInputSchema>;

export const transitionSchema = z.object({
  to: z.enum(STATUSES),
  reason: z.string().trim().max(1000).optional().default(''),
  signal: z.enum(SIGNALS).optional(),
  tailoring: z.enum(TAILORING).optional(),
  checklistAcknowledged: z.boolean().optional().default(false),
  redAcknowledged: z.boolean().optional().default(false),
  version: z.number().int().positive(),
});

export type TransitionInput = z.infer<typeof transitionSchema>;

export const commentSchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

export const roleSchema = z.object({
  role: z.enum(['requester', 'desk', 'approver']),
});

export const draftSchema = z.object({
  draft: z.record(z.string(), z.unknown()),
  step: z.number().int().min(0).max(6),
  editId: z.string().trim().max(20).optional().nullable(),
  at: z.string().trim().max(40).optional(),
});

export const importSchema = z.object({
  seq: z.number().int().nonnegative().optional(),
  items: z
    .array(
      z
        .object({
          id: z.string().trim().min(1).max(20),
          title: z.string().trim().min(1).max(60),
        })
        .passthrough(),
    )
    .max(5000),
});
