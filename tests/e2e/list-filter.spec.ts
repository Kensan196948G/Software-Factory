/**
 * 一覧のサーバ絞り込みの画面試験（L-08）を、必須の E2E スイートでも走らせる。
 *
 * 中身は `tests/browser/list-filter.spec.ts`（`src/web/index.html` と `src/web/public/*.js` を
 * そのまま読み、通信はすべて横取りする。実サーバ・実DB・本番/Staging・メールへは接続しない）。
 * ここで読み込むだけなので、E2E の webServer は起動するが、このファイルの試験はそれを使わない。
 *
 * `playwright.approver.config.ts`（`pnpm test:browser:approver`）からも同じ試験を実行できる。
 */
import '../browser/list-filter.spec.js';
