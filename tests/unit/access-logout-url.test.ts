import { describe, expect, it } from 'vitest';
import { accessLogoutUrl } from '../../src/api/config.js';

describe('accessLogoutUrl', () => {
  it('AUTH_MODE=access ならチームドメインのログアウト URL を返す', () => {
    expect(accessLogoutUrl({ authMode: 'access', accessTeamDomain: 'https://winter-lake-f4c9.cloudflareaccess.com' })).toBe(
      'https://winter-lake-f4c9.cloudflareaccess.com/cdn-cgi/access/logout',
    );
  });

  it('末尾スラッシュがあっても二重にしない', () => {
    expect(accessLogoutUrl({ authMode: 'access', accessTeamDomain: 'https://team.cloudflareaccess.com/' })).toBe(
      'https://team.cloudflareaccess.com/cdn-cgi/access/logout',
    );
  });

  it('password モードや未設定では null（アプリの /login へ戻す）', () => {
    expect(accessLogoutUrl({ authMode: 'password', accessTeamDomain: 'https://team.cloudflareaccess.com' })).toBeNull();
    expect(accessLogoutUrl({ authMode: 'access', accessTeamDomain: '' })).toBeNull();
  });
});
