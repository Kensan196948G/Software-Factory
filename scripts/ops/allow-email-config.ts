import { z } from 'zod';

export function parseProductionEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    if (eq < 1 || !/^[A-Z][A-Z0-9_]*$/.test(key) || values.has(key)) throw new Error('config_invalid');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    values.set(key, value);
  }
  if (
    values.get('APP_ENV') !== 'production' ||
    values.get('NODE_ENV') !== 'production' ||
    values.get('AUTH_MODE') !== 'access' ||
    !values.get('ACCESS_TEAM_DOMAIN') ||
    !values.get('ACCESS_AUD') ||
    values.get('ALLOW_SELF_APPROVAL') !== '0' ||
    values.get('MAIL_MODE') !== 'off'
  ) {
    throw new Error('security_config');
  }
  return values;
}

export function planSingleEmail(text: string, first: string, second: string): { text: string; email: string; changed: boolean } {
  const schema = z.email().max(200);
  const email = first.trim().toLowerCase();
  if (!schema.safeParse(email).success || /[\r\n,'"\\]/.test(email)) throw new Error('email_format');
  if (email !== second.trim().toLowerCase()) throw new Error('email_mismatch');
  const values = parseProductionEnv(text);
  const entries = (values.get('ACCESS_ALLOWED_EMAILS') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (entries.some((e) => !schema.safeParse(e).success || /[\r\n,'"\\]/.test(e))) throw new Error('config_invalid');
  const domain = values.get('ACCESS_ALLOWED_DOMAIN') ?? '';
  if (entries.includes(email) || (domain && email.endsWith(`@${domain.toLowerCase()}`))) return { text, email, changed: false };
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // The first allowed email is also the legacy service-token identity: never change it incidentally.
  if (entries.length === 0 && (values.get('ACCESS_SERVICE_TOKEN_IDS') ?? '').trim()) throw new Error('service_identity_change');
  const replacement = `ACCESS_ALLOWED_EMAILS=${[...entries, email].join(',')}`;
  const index = lines.findIndex((line) => /^\s*ACCESS_ALLOWED_EMAILS\s*=/.test(line));
  if (index < 0) {
    if (lines.at(-1) === '') lines.pop();
    lines.push(replacement, '');
  } else lines[index] = replacement;
  const candidate = lines.join(newline);
  const after = parseProductionEnv(candidate);
  for (const [key, value] of values)
    if (key !== 'ACCESS_ALLOWED_EMAILS' && after.get(key) !== value) throw new Error('config_invalid');
  return { text: candidate, email, changed: true };
}
