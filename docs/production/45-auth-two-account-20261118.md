# ログイン・認証の2アカウント化（2026-11-18）

作成: 2026-11-18 11:20 JST。対象: 本番（`mirai_sf_prod` / `127.0.0.1:8783` / unit `mirai-sf-prod-api`）と Staging（`mirai_sf` / `127.0.0.1:8782`）。状態: **実施記録**。時刻はすべて JST。数値は実測値のみを書き、未確認は「未確認」と書く。

## 1. 指示と範囲

- 2026-11-18 11:02 JST の所有者指示: 「まずログインと認証について、当分は **kensan1969@gmail.com を承認者、kenaritou@yahoo.co.jp を利用者** のみとしてください」。伏字で届いた実値は、本リポジトリの記録（`docs/production/04`、`32`）と本番 DB の有効利用者から補完して確定した。
- 範囲: アプリ（受付ステーション）の **有効な利用者を 2 名に限定し、役割を承認者 1・利用者 1 にする**こと、および本番のアプリ許可メール一覧を同じ 2 件に揃えること。
- 範囲外: Cloudflare Access のポリシー（会社ドメイン許可を含む）は変更しない（`04` §1 の所有者判断「既存のドメイン/所有者許可を消さない」を維持）。SSO・パスワード方針・自己承認の設定も変更しない。

## 2. 変更前後の状態（実測）

| 項目                                   | 変更前（11:10 読取り）                  | 変更後（11:17 読取り）           |
| -------------------------------------- | --------------------------------------- | -------------------------------- |
| 本番の有効な利用者                     | 3 名（管理者 1）                        | **2 名（管理者 1）**             |
| ken\*\*\*@gmail.com                    | 管理者=true / `approver;desk;requester` | 管理者=true / **`approver`**     |
| ken\*\*\*@yahoo.co.jp                  | 管理者=false / `desk;requester`         | 管理者=false / **`requester`**   |
| r-k\*\*\*@mirai-const.co.jp            | 管理者=false / `approver` / 有効        | **無効**（役割は履歴のため保持） |
| Staging の有効な利用者                 | 3 名（管理者 2）                        | **2 名（管理者 1）**             |
| k-a\*\*\*@mirai-const.co.jp（Staging） | 管理者=true / 3 役 / 有効               | **無効**                         |
| 本番 `/healthz` の `auth.usersActive`  | 3                                       | **2**（`auth.status=ready`）     |

- 実行者は AI（Lead）である。監査には所有者本人を装わず、`actor_name=local-cli uid=1000` / `role=system` / `diff.source=local-cli` として記録した（`src/api/auth.ts` の `LocalAdminActor`。`authorizationAdminId` に既存管理者の ID を残す）。
- 監査行（本番 `audit_log`、11:16:27）: `user.roles`（承認者）、`user.roles`（利用者）、`user.deactivate`（外部承認者）の 3 件。`audit_log` は 15 → 18 行。

## 3. 方法

1. **利用者と役割**（本番・Staging）: リポジトリの正規関数 `setUserRoles` / `setUserActive`（`src/api/auth.ts`）だけを使うローカル CLI を一時実行した。DB の直接 UPDATE はしていない。`--apply` の前に、計画（変更前 → 変更後）を表示して確認した。
   - 承認者: `approver` のみ。**管理者フラグは維持**（利用者管理 API を使えるようにするため。業務上の役割は承認者）。
   - 利用者: `requester` のみ。管理者ではない。
   - 上記 2 名以外の**有効な**利用者は無効化（`setUserActive(false)`。同時にその利用者のセッションも削除される）。
2. **本番のアプリ許可メール**（`~/.config/mirai-sf/prod.conf` の `ACCESS_ALLOWED_EMAILS`）: 3 件 → 2 件（上記 2 名のみ）。退避 `prod.conf.bak-20261118T111646`（0600）、0600 のまま原子的に置換、他の 28 行は不変。設定は起動時読込みのため、`mirai-sf-prod-api.service` を 11:16:51 に再起動した（healthz 200 まで 2 秒。停止は再起動に伴う数秒）。
3. Staging の許可メール（`preview.conf`）は既に 2 件（上記 2 名）だったため変更なし。Staging は DB の変更のみで、再起動していない（役割は要求ごとに DB から解決される）。

## 4. 検証（実測）

| 検証                       | 結果                                                                                                                           | 根拠                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| 本番の有効利用者           | 2 名（approver / requester）                                                                                                   | `psql -X -d mirai_sf_prod` の読み取り    |
| 本番 `/healthz`            | 200、`auth.status=ready`、`usersActive=2`、`commit=17c91f43…`（11:16 時点）                                                    | `curl`                                   |
| 許可関数の評価（本番設定） | gmail=**true** / yahoo=**true** / 外部承認者の会社アドレス=true（**会社ドメイン許可のため**）/ 旧 takamatsu-cg.co.jp=**false** | `isAccessEmailAllowed` を本番設定で評価  |
| 未登録・無効の利用者       | アプリが拒否する（`USER_WITH_ROLES` は `is_active` のみ対象。未登録は本番で自動登録しない）                                    | `src/api/auth.ts` 52-58 行、249-280 行   |
| ヘッダ信頼（JWT 無し）     | `Cf-Access-Authenticated-User-Email` を付けても **401 `ERR-106`**                                                              | `curl http://127.0.0.1:8783/api/auth/me` |
| 機械受入                   | **14/14 PASS**（11:18 の配備後。`auth.status=ready`、auth 警告なし、DB `app_user=3`＝無効 1 を含む全行数）                     | `pnpm ops:prod:acceptance bb7c2426…`     |

- 会社ドメイン（`mirai-const.co.jp`）のアドレスは、アプリの許可関数では true になる（`ACCESS_ALLOWED_DOMAIN`）。ただし `app_user` に有効な行が無いため、**ログインはアプリ側で 403 になり、`auth.access_denied`（`user_not_registered`）が監査に残る**。Cloudflare Access は会社ドメインを引き続き許可する（変更しない）。
- 実際の OTP ログイン（ブラウザ）は、人間の受信が必要なため未実施である。上記はアプリ側の判定の実測とコード経路の確認であり、**ログイン成功の実測ではない**。

## 5. 役割構成の影響（受付担当が居なくなること）

- 変更後は `desk`（受付担当）だけを持つ利用者が居ない。`src/shared/domain.ts` の `roleCanTransition` では、**承認者は「承認済み」「完了」以外の遷移もできる**（`desk` 専任は必須ではない）。したがって業務フロー（受付 → 内容確認中 → 承認待ち → 承認済み）は、承認者 1 名と利用者 1 名で完了できる。
- 職務分離の要（依頼者と承認者が別人）は維持される。利用者は `requester` のみなので、自分の依頼を承認・進行できない（`ERR-201` / `ERR-105`）。
- 一方で、**受付（desk の職務）と承認（approver の職務）を同じ 1 名が担う**ことになる。`docs/limitations.md` L-01/L-02 の「1人に複数ロールを付与できる」制約と同種の残余であり、本番の統制上は「受付と承認の分離が無い」状態である。所有者の指示（当分は 2 名）による暫定運用として記録する。
- 業務受入の参加者・手順は `42-business-acceptance-plan-20261113.md` を、この構成に合わせて更新した（`42` §1・§2 の注記）。

## 6. 復旧（任意）

- 外部承認者を戻す場合: `setUserActive(<id>, true, actor, cid)` で有効化し、必要なら `setUserRoles` で `approver` を再付与する（無効化で役割は消していないため、有効化だけで元の役割に戻る）。
- 本番の許可メールを戻す場合: 退避 `prod.conf.bak-20261118T111646` を用い、0600 を確認して置換し、`mirai-sf-prod-api.service` を再起動する。バックアップを最新設定へ上書きしない。
- 役割の変更は監査（`user.roles`）に前後が残る。無効化はセッションも削除するため、利用者は再ログインが必要になる。

## 7. 限界・未確認

- OTP ログインの実測（人間）は未実施。Cloudflare Access のポリシーは変更していないため、会社ドメインの利用者は Access を通過できる（アプリで 403）。
- Staging は DB のみ変更し、再起動していない。Staging の画面からのログインは未実測。
- 承認者 1 名の構成では、その利用者が無効化・退職すると承認できる人が居なくなる（管理者フラグは残るため利用者管理は可能）。`docs/limitations.md` L-02 の既知の制約と同じ。

## 8. 参照

- `26-release-status.md`（本番の状態・承認の正本。本変更を §2 に反映）
- `04-external-approver-allowlist.md`（Cloudflare とアプリの許可の扱い）
- `32-staging-user-charset-20261111.md`（利用者追加の前例）
- `src/api/auth.ts`（`setUserRoles` / `setUserActive` / `LocalAdminActor`）、`src/shared/domain.ts`（`roleCanTransition`）
