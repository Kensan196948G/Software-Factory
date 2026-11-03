import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordPolicyError } from '../../src/api/password.js';

describe('管理APIのパスワード方針', () => {
  it('短すぎるパスワードは断る', () => {
    const error = passwordPolicyError('a'.repeat(PASSWORD_MIN_LENGTH - 1));
    expect(error).toContain(`${PASSWORD_MIN_LENGTH}文字`);
  });

  it('長すぎるパスワードは断る', () => {
    const error = passwordPolicyError('a'.repeat(PASSWORD_MAX_LENGTH + 1));
    expect(error).toContain(`${PASSWORD_MAX_LENGTH}文字`);
  });

  it('空白だけは断る', () => {
    expect(passwordPolicyError('          ')).toBeTruthy();
  });

  it('メールアドレスと同じパスワードは断る（大文字小文字は区別しない）', () => {
    expect(passwordPolicyError('User@Example.com', 'user@example.com')).toContain('メールアドレス');
  });

  it('方針を満たせば通す', () => {
    expect(passwordPolicyError('separation-pass-1234', 'user@example.com')).toBeNull();
  });
});
