import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LocalAdminActor, CreateUserInput, ManagedUser } from '../../src/api/auth.js';

export interface AddUserDependencies {
  ask: (prompt: string) => Promise<string>;
  print: (text: string) => void;
  actor: LocalAdminActor;
  findUser: (email: string) => Promise<ManagedUser | null>;
  departmentExists: (code: string) => Promise<boolean>;
  emailAllowed: (email: string) => boolean;
  create: (input: CreateUserInput, actor: LocalAdminActor, correlationId: string) => Promise<ManagedUser>;
}

const emailSchema = z.string().trim().toLowerCase().email().max(200);
const clean = (text: string, max: number) => {
  const value = text.trim();
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('invalid_input');
  return value;
};

/** Local privileged maintenance, not an Access login. Existing accounts are never changed. */
export async function addUserInteractively(d: AddUserDependencies): Promise<'created' | 'existing' | 'cancelled'> {
  if (!d.actor.isAdmin) throw new Error('not_admin');
  const email = emailSchema.parse(await d.ask('登録するメールアドレス: '));
  const again = emailSchema.parse(await d.ask('確認のため、同じメールアドレスを再入力: '));
  if (email !== again) throw new Error('email_mismatch');
  if (!d.emailAllowed(email)) throw new Error('email_not_allowed');
  if (await d.findUser(email)) {
    d.print('登録済みです。既存利用者の権限・有効状態は変更していません。');
    return 'existing';
  }
  const displayName = clean(await d.ask('表示名: '), 80);
  const deptCode = clean(await d.ask('部署コード（DX推進部は dx）: '), 20);
  if (!(await d.departmentExists(deptCode))) throw new Error('unknown_department');
  const admin = await d.ask('管理者権限も付与しますか？（付与する場合だけ YES）: ');
  if (admin !== 'YES' && admin !== 'NO') throw new Error('admin_choice_required');
  const isAdmin = admin === 'YES';
  d.print(
    `\n対象: 本番 mirai_sf_prod\nメール: ${email}\n表示名: ${displayName}\n部署: ${deptCode}\nロール: 承認者\n管理者: ${isAdmin ? 'あり（利用者管理も可能）' : 'なし'}\n`,
  );
  if ((await d.ask('この1名を本番登録します。確定する場合だけ CREATE: ')) !== 'CREATE') {
    d.print('中止しました。登録していません。');
    return 'cancelled';
  }
  const correlationId = `local-cli:${randomUUID()}`;
  const user = await d.create(
    { email, displayName, deptCode, roles: ['approver'], isAdmin, password: randomBytes(32).toString('hex') },
    d.actor,
    correlationId,
  );
  if (!user.id || !user.isActive || user.isAdmin !== isAdmin || !user.roles.includes('approver')) {
    throw new Error('verification_failed');
  }
  d.print(
    `登録成功。利用者ID: ${user.id}\n監査照合ID: ${correlationId}\n本人がAccess OTPでログインしてください。OTP・パスワードは共有不要です。`,
  );
  return 'created';
}
