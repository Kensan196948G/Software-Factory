/**
 * local-run.mjs が子プロセスへ渡す環境を作る。
 *
 * - 通常の設定は `~/.config/mirai-sf/local.json` を process.env に重ねる（従来どおり local.json が優先）。
 * - **DEVLINE_ALLOW_PRODUCTION だけは例外**。本番の安全スイッチなので、呼び出し元の明示環境だけを通し、
 *   local.json の値では有効にしない（設定ファイルの置き忘れで本番が有効にならないように）。
 *   値の解釈（0 / 1 の検証・既定拒否）は src/api/config.ts と devline-real-config.ts が持つ。
 *   docs/devline/production-automation.md
 */

const SAFETY_SWITCH = 'DEVLINE_ALLOW_PRODUCTION';

/**
 * @param {{ processEnv: Record<string, string | undefined>, fileConfig: Record<string, string | undefined>, configPath: string }} input
 * @returns {Record<string, string | undefined>}
 */
export function childEnv({ processEnv, fileConfig, configPath }) {
  const env = { ...processEnv, ...fileConfig, MIRAI_SF_CONFIG_FILE: configPath };
  if (processEnv[SAFETY_SWITCH] === undefined) {
    delete env[SAFETY_SWITCH];
  } else {
    env[SAFETY_SWITCH] = processEnv[SAFETY_SWITCH];
  }
  return env;
}
