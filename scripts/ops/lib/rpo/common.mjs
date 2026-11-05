/**
 * rpo-report の共通部品（定数・時刻の厳密な解析・表示用の整形）。副作用なし。
 */

export const MINUTE_MS = 60_000;
/** 時計ずれの許容幅。未来方向・世代との矛盾の判定に使う。 */
export const SKEW_MS = 5 * MINUTE_MS;
/** 読む JSON（送信記録・healthcheck の状態ファイル）の上限。 */
export const JSON_MAX_BYTES = 64 * 1024;
export const MAX_DAYS = 90;
export const MAX_LISTED_GAPS = 50;
/** 出力で保存先・状態ファイルを示す固定表現（フルパスは出さない）。 */
export const BACKUP_DIR_LABEL = 'BACKUP_DIR';
export const HEALTH_STATE_LABEL = 'HEALTH_STATE';

const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** ファイル名は形を検証してから出す（改行・制御文字で出力を汚さない）。 */
export function safeName(name) {
  return SAFE_NAME_PATTERN.test(name) ? name : '(想定外の名前)';
}

/**
 * ISO 8601（タイムゾーン必須）を厳密に解析する。Date.parse は 2026-02-31 などを正規化して受理するため使わない。
 * 年月日時分秒とオフセットを範囲検証し、日付は UTC で往復させて一致を確かめる。不正なら null。
 */
export function parseStrictIso(value) {
  if (typeof value !== 'string') return null;
  const matched = ISO_PATTERN.exec(value);
  if (!matched) return null;
  const [, y, mo, d, h, mi, s = '0', frac = '0', sign, oh, om] = matched;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const millis = Number(frac.padEnd(3, '0'));
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const back = new Date(wall);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour ||
    back.getUTCMinutes() !== minute ||
    back.getUTCSeconds() !== second ||
    back.getUTCMilliseconds() !== millis
  ) {
    return null;
  }
  let offsetMs = 0;
  if (sign !== undefined) {
    const offsetHours = Number(oh);
    const offsetMinutes = Number(om);
    // 実在するオフセットは -12:00〜+14:00 だが、ここでは ±14:00 までを受け付ける（14 時台は 14:00 ちょうどだけ）
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) return null;
    offsetMs = (sign === '+' ? 1 : -1) * (offsetHours * 60 + offsetMinutes) * MINUTE_MS;
  }
  return wall - offsetMs;
}

export function iso(ms) {
  return new Date(ms).toISOString();
}

/** 表示用の分（小数 1 桁）。判定には使わない。 */
export function minutes(ms) {
  return Math.round((ms / MINUTE_MS) * 10) / 10;
}

/** 表示用の「分:秒.ミリ秒」（例 60:00.097）。判定はミリ秒で行うので、表示もミリ秒まで出す。 */
export function clock(ms) {
  const total = Math.floor(Math.max(0, ms));
  const totalSeconds = Math.floor(total / 1000);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${Math.floor(totalSeconds / 60)}:${seconds}.${String(total % 1000).padStart(3, '0')}`;
}
