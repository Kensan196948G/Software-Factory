/** Fixed-token operator confirmation. Never treat empty/unknown input as consent. */
export async function confirmInput(
  ask: (prompt: string) => Promise<string>,
  print: (text: string) => void,
  prompt: string,
  token: 'CF-SAVED' | 'MAINTENANCE' | 'APPLY',
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await ask(`${prompt}\n入力: ${token} ／ 中止: CANCEL > `)).trim();
    if (answer === token) return true;
    if (answer === 'CANCEL') {
      print('中止しました。設定変更・再起動は行っていません。');
      return false;
    }
    print(`確認文字が一致しません。「${token}」だけを入力してEnterを押してください。説明文や「→ Enter」は入力しません。`);
  }
  print('確認が3回一致しなかったため中止しました。設定変更・再起動は行っていません。');
  return false;
}
