import { ZodError } from 'zod';

/** Only fixed, allowlisted text is printed. Never interpolate exception/input/config values. */
const messages: Record<string, string> = {
  email_mismatch: 'メールアドレスの2回の入力が一致しません。未登録です。',
  email_not_allowed: 'このメールはアプリのログイン許可対象外です。未登録です。許可範囲の確認が必要です（自動では変更しません）。',
  invalid_input:
    '表示名または部署コードが空・長すぎる・制御文字を含むため停止しました。未登録です。部署は名称ではなくコード（DX推進部なら dx）です。',
  unknown_department:
    '部署コードが登録されていません。未登録です。DX推進部なら半角の dx を入力してください。他部署はコードを確認してください。',
  admin_choice_required: '管理者の質問には半角大文字の YES または NO を入力してください。未登録です。',
  not_admin: 'ローカル運用権限を確認できません。未登録です。',
  terminal_required: '対話できるLinux端末で直接実行してください。パイプやリダイレクトは使えません。未登録です。',
  run_as_owner_not_root: 'sudo/rootではなく本番設定の所有者ユーザーで実行してください。未登録です。',
  production_wrapper_required: '案内した MIRAI_SF_ENV_FILE と with-env.mjs を付けて実行してください。未登録です。',
  config_owner_permissions: '本番設定の所有者・種類・パーミッションを確認できません。未登録です。',
  mixed_configuration: '別の設定ファイルが混在しています。設定を確認してください。未登録です。',
  invalid_config: '本番設定に不正行または重複キーがあります。未登録です。',
  security_config_required: '本番環境・既存管理者・Access JWTの必須設定が不足しています。未登録です。',
  wrong_environment: '接続先が指定の本番DB/認証設定と一致しません。未登録です。',
  local_operator_required: 'ローカルDB運用者の接続・権限を確認できません。未登録です。',
  existing_admin_required: '有効な既存管理者を確認できません。未登録です。',
  unsupported_arguments: '指定できる引数は --check または --help だけです。メールは端末の質問へ入力してください。未登録です。',
  verification_failed:
    '書込み後の確認が完了しませんでした。登録済みの可能性があります。表示した監査照合IDで確認し、再実行は待ってください。',
};

export function safeAddUserError(error: unknown): string {
  if (error instanceof ZodError)
    return '停止 [email_format]: メールアドレスの形式を確認してください。伏せ字ではなく実際のアドレスを端末へ入力してください。未登録です。';
  if (error instanceof Error && Object.hasOwn(messages, error.message)) {
    return `停止 [${error.message}]: ${messages[error.message]}`;
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.message === 'The operation was aborted')) {
    return '停止 [cancelled]: 入力を中止しました。書込み開始前なら未登録です。';
  }
  return '停止 [unexpected]: 処理を完了できませんでした。登録結果は未確認です。書込み開始後なら表示した監査照合IDで確認し、再実行は待ってください。';
}
