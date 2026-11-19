# Access ログアウト後の再ログイン不能（No Access cookie found）— 原因と修正（2026-11-11）

作成: 2026-11-11 JST。対象: Staging `sf.mirai-dx-platform.com`（本番 `sf-prod.mirai-dx-platform.com` も同じ実装）。状態: **修正実装済み・Staging／本番配備済み**（`ab771376`、2026-11-11 16:11 JST）。

## 1. 症状

- B（外部メール、`Kenaritou`）でログインできることを確認した。
- ログアウト後、再ログインしようとすると次のページになる。

```
Error ・ Cloudflare Access
No Access cookie found. Please login first.
```

## 2. 原因

アプリの「ログアウト」は、アプリのセッションを失効させた後に Cloudflare Access のログアウトへ遷移する。遷移先が**チームドメイン**（`https://winter-lake-f4c9.cloudflareaccess.com/cdn-cgi/access/logout`）だった。

- チームドメインのログアウトは、**そのドメインの Cookie** を持つブラウザでだけ成功する。B のブラウザにはチームドメインの Cookie が無かったため、Access は削除する Cookie を見つけられず、`No Access cookie found. Please login first.` のエラーページを返した（2026-11-11 実測）。
- 同時に、**アプリのドメインの Cookie**（`sf.mirai-dx-platform.com` の `CF_Authorization`）は削除されない。そのため、同じブラウザで別の利用者としてログインし直す目的も達成できない。

実測（Cookie なしの `curl`）:

| URL | 応答 |
| --- | --- |
| `https://sf.mirai-dx-platform.com/cdn-cgi/access/logout` | 200 / `Error ・ Cloudflare Access` / `No Access cookie found. Please login first.` |
| `https://winter-lake-f4c9.cloudflareaccess.com/cdn-cgi/access/logout` | 200 / 同じエラー |
| `https://sf.mirai-dx-platform.com/` | 302 → Access ログイン（正常） |

Cloudflare の仕様では、ログアウト URL はアプリのドメインでもチームドメインでもよいが、**削除される Cookie のドメインが異なる**。アプリのドメインでログアウトする方が即時で、アプリの Cookie も消える（[Session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)）。

## 3. 修正

`accessLogoutUrl()`（`src/api/config.ts`）を、**アプリのドメイン**のログアウト URL に変更した。

```
https://<APP_BASE_URL のオリジン>/cdn-cgi/access/logout?returnTo=<アプリのルート（URL エンコード）>
```

- `APP_BASE_URL` は staging `https://sf.mirai-dx-platform.com`、本番 `https://sf-prod.mirai-dx-platform.com`。
- `returnTo` でアプリのルートへ戻す。Access が Cookie を消した後にアプリへ戻り、次のリクエストで OTP ログインへ繋がる。
- http（ローカル）や不正な `APP_BASE_URL`、password モードでは `null` を返し、従来どおりアプリの `/login` へ戻す。
- 画面側（`src/web/public/bridge.js`）の検証も更新した。アプリと同じドメインの `/cdn-cgi/access/logout` を受け付け、`returnTo` は**同じアプリの https URL だけ**を許可する（外部への転送を防ぐ）。チームドメインの URL は互換のため引き続き受け付ける。

## 4. 検証

- unit: `tests/unit/access-logout-url.test.ts` — アプリのドメイン・`returnTo`・password/http/不正値の 3 件が pass。
- 画面のログアウト（password モード）: 既存 E2E の「ログアウトするとアプリのセッションが失効し、ログイン画面へ戻る」で従来どおり。
- Staging: 2026-11-11 15:49 配備。所有者が実機でログアウト→再ログインを確認し、**OK**。
- 本番: 2026-11-11 16:11 配備（`ab771376`）。機械受入 14/14 PASS。

## 5. いま困っている場合の回避手順

1. エラーのタブを閉じ、**新しいタブで `https://sf.mirai-dx-platform.com/` を開く**（ログアウト URL を再読込しない）。
2. それでも自動ログインやエラーが残る場合は、`sf.mirai-dx-platform.com` と `winter-lake-f4c9.cloudflareaccess.com` の Cookie を削除してから開く（またはシークレットウィンドウ）。
3. ログアウト URL を直接開いた場合、Cookie が無いと Access のエラーページになる（仕様）。アプリの URL から入り直す。

## 6. 既知の制限

- すでにログアウト済み（アプリの Cookie が無い）状態で `/cdn-cgi/access/logout` を直接開くと、同じ Access のエラーページになる。通常の画面操作では起こらない。
- ログアウト後にブラウザの「戻る」でログアウト URL を再実行した場合も同じ。アプリの URL から入り直す。

## 7. ロールバック

- 本修正の PR を revert する（設定値の生成と画面の検証のみ。DB・Cookie の変更なし）。
