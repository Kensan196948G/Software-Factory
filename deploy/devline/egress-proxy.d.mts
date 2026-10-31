import type { Server } from 'node:http';

export const DEFAULT_ALLOW: readonly string[];
export function parseConnectTarget(raw: unknown): { host: string; port: number; key: string } | null;
export function isAllowedTarget(raw: unknown, allow?: readonly string[]): boolean;
export function isPrivateAddress(address: string): boolean;
export function createEgressProxy(options?: {
  allow?: readonly string[];
  allowPrivate?: boolean;
  log?: (line: object) => void;
}): Server;
