import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { safeAddUserError } from '../../scripts/ops/add-user-errors.js';

describe('provisioning error diagnostics without PII or secret leakage', () => {
  it.each([
    'email_mismatch',
    'email_not_allowed',
    'unknown_department',
    'admin_choice_required',
    'terminal_required',
    'wrong_environment',
  ])('explains %s', (code) => {
    expect(safeAddUserError(new Error(code))).toContain(`[${code}]`);
    expect(safeAddUserError(new Error(code))).toContain('未登録');
  });
  it('does not echo rejected email from Zod issues', () => {
    const result = z.email().safeParse('private-invalid@example');
    if (result.success) throw new Error('fixture');
    expect(safeAddUserError(result.error)).toContain('[email_format]');
    expect(safeAddUserError(result.error)).not.toContain('private-invalid');
  });
  it('never echoes arbitrary database exception text', () => {
    const error = new Error('postgresql://secret-user:secret-password@db.example/private');
    expect(safeAddUserError(error)).toContain('[unexpected]');
    expect(safeAddUserError(error)).not.toContain('secret');
    expect(safeAddUserError(error)).not.toContain('db.example');
  });
  it('rejects prototype property names and unknown error shapes safely', () => {
    expect(safeAddUserError(new Error('toString'))).toContain('[unexpected]');
    expect(safeAddUserError({ message: 'email_mismatch', input: 'private@example.com' })).not.toContain('private');
  });
  it('does not claim no write after verification failure', () => {
    expect(safeAddUserError(new Error('verification_failed'))).toContain('登録済みの可能性');
  });
});
