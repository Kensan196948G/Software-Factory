import { describe, expect, it } from 'vitest';
import { accessLogoutUrl } from '../../src/api/config.js';

const APP = 'https://sf.mirai-dx-platform.com';

describe('accessLogoutUrl', () => {
  it('AUTH_MODE=access ならアプリのドメインのログアウト URL を返す（チームドメインではない）', () => {
    expect(accessLogoutUrl({ authMode: 'access', appBaseUrl: APP })).toBe(
      'https://sf.mirai-dx-platform.com/cdn-cgi/access/logout?returnTo=https%3A%2F%2Fsf.mirai-dx-platform.com%2F',
    );
  });

  it('returnTo は同じアプリのルートを指す', () => {
    const raw = accessLogoutUrl({ authMode: 'access', appBaseUrl: 'https://sf-prod.mirai-dx-platform.com' });
    expect(raw).not.toBeNull();
    const url = new URL(raw as string);
    expect(url.hostname).toBe('sf-prod.mirai-dx-platform.com');
    expect(url.pathname).toBe('/cdn-cgi/access/logout');
    expect(url.searchParams.get('returnTo')).toBe('https://sf-prod.mirai-dx-platform.com/');
  });

  it('password モード・http・不正値では null（アプリの /login へ戻す）', () => {
    expect(accessLogoutUrl({ authMode: 'password', appBaseUrl: APP })).toBeNull();
    expect(accessLogoutUrl({ authMode: 'access', appBaseUrl: 'http://127.0.0.1:8781' })).toBeNull();
    expect(accessLogoutUrl({ authMode: 'access', appBaseUrl: 'not a url' })).toBeNull();
    expect(accessLogoutUrl({ authMode: 'access', appBaseUrl: '' })).toBeNull();
  });
});
