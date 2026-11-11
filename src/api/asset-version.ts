/**
 * 画面が読み込むスクリプトの URL に版を付ける。
 * Cloudflare がブラウザ向けのキャッシュを 4 時間に書き換えるので、同じ URL のままだと、
 * 反映した後もブラウザが古いファイルを動かし続ける。HTML はキャッシュされないので、URL を変えれば届く。
 */
export function versionAssets(html: string, version: string): string {
  const v = encodeURIComponent(version);
  return html
    .replace(/<script src="\/(bridge|console|station-bridge|station)\.js"><\/script>/g, (_, name: string) => {
      return `<script src="/${name}.js?v=${v}"></script>`;
    })
    .replace(/<link rel="stylesheet" href="\/(station)\.css">/g, (_, name: string) => {
      return `<link rel="stylesheet" href="/${name}.css?v=${v}">`;
    });
}
