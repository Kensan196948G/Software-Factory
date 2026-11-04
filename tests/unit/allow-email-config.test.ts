import { describe, expect, it } from 'vitest';
import { parseProductionEnv, planSingleEmail } from '../../scripts/ops/allow-email-config.js';
const base = `# synthetic fixture; never production values
NODE_ENV=production
APP_ENV=production
AUTH_MODE=access
ACCESS_TEAM_DOMAIN=https://fake.cloudflareaccess.com
ACCESS_AUD=fake-aud
ALLOW_SELF_APPROVAL=0
MAIL_MODE=off
ACCESS_ALLOWED_DOMAIN=example.org
ACCESS_ALLOWED_EMAILS='owner@example.com'
SESSION_SECRET=synthetic-only
`;
describe('single-email configuration plan (no filesystem/services)', () => {
  it('adds exactly one address and preserves every other config value', () => {
    const plan = planSingleEmail(base, ' Friend@external.example ', 'friend@external.example');
    expect(plan.changed).toBe(true);
    expect(plan.email).toBe('friend@external.example');
    const before = parseProductionEnv(base),
      after = parseProductionEnv(plan.text);
    for (const [key, value] of before) if (key !== 'ACCESS_ALLOWED_EMAILS') expect(after.get(key)).toBe(value);
    expect(after.get('ACCESS_ALLOWED_EMAILS')).toBe('owner@example.com,friend@external.example');
  });
  it.each(['owner@example.com', 'staff@example.org'])('makes no change for already permitted %s', (email) => {
    expect(planSingleEmail(base, email, email)).toEqual({ text: base, email, changed: false });
  });
  it.each([
    ['<EMAIL_2>', '<EMAIL_2>'],
    ['bad@@example.com', 'bad@@example.com'],
    ['a@external.example\nMAIL_MODE=smtp', 'a@external.example\nMAIL_MODE=smtp'],
    ['a@external.example', 'b@external.example'],
    ["'a'@external.example", "'a'@external.example"],
  ])('rejects unsafe or mismatched input', (a, b) => {
    expect(() => planSingleEmail(base, a, b)).toThrow();
  });
  it('rejects duplicate keys instead of overwriting ambiguous config', () => {
    expect(() =>
      planSingleEmail(base + 'ACCESS_ALLOWED_EMAILS=another@example.com\n', 'friend@external.example', 'friend@external.example'),
    ).toThrow('config_invalid');
  });
  it.each([
    ['APP_ENV=production', 'APP_ENV=staging'],
    ['AUTH_MODE=access', 'AUTH_MODE=password'],
    ['ALLOW_SELF_APPROVAL=0', 'ALLOW_SELF_APPROVAL=1'],
    ['MAIL_MODE=off', 'MAIL_MODE=smtp'],
    ['ACCESS_AUD=fake-aud', 'ACCESS_AUD='],
  ])('fails closed on unsafe security configuration', (a, b) => {
    expect(() => parseProductionEnv(base.replace(a, b))).toThrow('security_config');
  });
  it('supports CRLF and no trailing newline without changing unrelated content', () => {
    const fixture = base.trimEnd().replaceAll('\n', '\r\n');
    const plan = planSingleEmail(fixture, 'friend@external.example', 'friend@external.example');
    expect(plan.text).toContain('\r\nSESSION_SECRET=synthetic-only');
    expect(plan.text.endsWith('\n')).toBe(false);
  });
  it('rejects changing the first-email service-token principal', () => {
    const fixture =
      base.replace("ACCESS_ALLOWED_EMAILS='owner@example.com'", 'ACCESS_ALLOWED_EMAILS=') +
      'ACCESS_SERVICE_TOKEN_IDS=fake-token-id\n';
    expect(() => planSingleEmail(fixture, 'friend@external.example', 'friend@external.example')).toThrow(
      'service_identity_change',
    );
  });
  it('preserves the first email and service token identity when appending', () => {
    const fixture = base + 'ACCESS_SERVICE_TOKEN_IDS=fake-token-id\n';
    const plan = planSingleEmail(fixture, 'friend@external.example', 'friend@external.example');
    expect(parseProductionEnv(plan.text).get('ACCESS_ALLOWED_EMAILS')?.split(',')[0]).toBe('owner@example.com');
  });
  it('adds missing list while retaining existing domain', () => {
    const fixture = base.replace("ACCESS_ALLOWED_EMAILS='owner@example.com'\n", '');
    expect(
      parseProductionEnv(planSingleEmail(fixture, 'friend@external.example', 'friend@external.example').text).get(
        'ACCESS_ALLOWED_DOMAIN',
      ),
    ).toBe('example.org');
  });
});
