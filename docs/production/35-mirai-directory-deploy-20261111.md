# Mirai-Info の部署・社員名への整合 — 本番配備記録（2026-11-11）

作成: 2026-11-11 JST。対象: Staging / 本番。状態: **両環境へ配備済み・本番受入 14/14 PASS**（`797f8a06`、2026-11-11 21:47 JST）。

## 1. 目的

WebUI（新しい依頼・ログイン表示・一覧・道具カタログ）の部署・起票者を、Mirai-Info の組織
（`mirai_info.employee_directory` / `org_units`）と社員名に合わせる。設計は `docs/design/station-ui.md` §4.5。

## 2. 実装（PR #172）

| 項目 | 内容 |
| --- | --- |
| マージ | `797f8a06`（2026-11-11T12:29:07Z、Squash）。main push CI `43020730205` は quality / e2e / docker すべて success |
| 部署 | Mirai-Info の division 16（グループ会社の青木マリーンは除外）。旧・機能別の 19 部署は `selectable=false` で履歴用に残す |
| 道具 | `department_tool` に 118 道具・298 対応。同じ道具を複数の部署に出す |
| 社員名 | `mirai_employee`（有効 431 名）。持つのは氏名・ヨミ・部署・課だけ（メール・連絡先は持たない） |
| DB | `db/migrations/0017_mirai_directory.sql`（追加のみ） |
| 同期 | `scripts/ops/sync-mirai-directory.mjs`（冪等。旧部署コードの依頼・利用者の移動と、見本の起票者名の置換を含む） |

## 3. Staging（2026-11-11 21:40 JST）

- 21:40:17 に autofollow 開始 → exact-main CI ゲート OK → 21:40:36 に migration 0017 適用 →
  21:40:37 に current 切替 → healthz が `797f8a06` と一致。
- 同期結果: `divisions=16 / mappings=298 / employees=431 / moved_requests=11 / moved_users=2 /
  renamed_applicants=14 / skipped_divisions=1`（青木マリーン）。
- 実測: `department` の選択可能 16・`department_tool` 298 行・`mirai_employee` 431 行（有効）。
  依頼 14 件はすべて新部署へ移動し、起票者はその部署の名簿の社員名と一致（旧部署コードの依頼 0 件）。
- API クエリ層（実コードを Staging DB に対して実行）: 部署 16・道具 118・社員 431 名/16 区分
  （大阪支店 70 名）・「操作する人」3 役すべて解決。
- 定期ヘルスチェック 21:45 OK（commit 一致・db.ok・auth ready・警告なし）。配備後 5xx 0・
  `mirai-sf-api.service` NRestarts 0。

## 4. 本番（2026-11-11 21:47 JST）

- 事前バックアップ: `mirai_sf_prod-20261111T124702Z.dump`（139,010 B・28 テーブル・14 日保持・
  R2 へのオフサイト送信 OK）。
- 21:47:02 に migration 0017 適用（30 テーブル）→ 21:47:19 に current を `ab771376` から切替 →
  21:47:20 に healthz が `797f8a06` と一致。
- 同期結果: `divisions=16 / mappings=298 / employees=431 / moved_requests=0 / moved_users=2 /
  renamed_applicants=0`（本番は依頼 0 件のため起票者名の置換は発生せず）。
- 受入: `prod-acceptance.ts 797f8a06` が **14/14 PASS**（healthz 200・environment=production・
  commit 一致・db.ok、readyz 200、unit active/Result=success/NRestarts 0、起動以降の 5xx 0、
  healthcheck ok/警告なし/healthCommit 一致、DB 読み取り、R2 直近世代の size/SHA-256 一致）。
- DB: `app_user=3` / `audit_log=15` / `request=0` / `session=7` / `migration=0017_mirai_directory.sql`。
- 配信物: `releases/797f8a06…/dist/web/station.js` の sha256 は
  `40e752cd801aa9dfe10bbdd4aed893cb3ac0d7731ff03237999a9c278e5594a0` で、Staging の同一リリースと一致。
- 公開 URL: `https://sf.mirai-dx-platform.com/` は 302 → Cloudflare Access のログイン（正常）。

## 5. データの扱い（PII）

- `mirai_employee` に持つのは氏名・ヨミ・部署・課だけ。メール・連絡先は取り込まない。
- リポジトリに入れるのは見本名簿（`TEST-*`）だけ。実名は DB のみに置き、同期スクリプトも標準出力に実名を出さない。
- グループ会社の青木マリーン（1 名）は部署・名簿に含めない。
- 「操作する人」の表示は役割を確かめるためのデモで、実際のログイン利用者とは別。監査・履歴はサーバの実利用者名のまま。

## 6. ロールバック

- `bash scripts/ops/prod-rollback.sh ab771376025ebee2c995afc841277c1813df9100` で旧リリースへ戻す。
- migration 0017 は追加のみ（`department` の列追加、`department_tool`、`mirai_employee`）。旧版はこれらの表・列を
  参照しないため、戻した後もデータは残る。削除が必要な場合は別途承認のうえ実施する。

## 7. 既知の制限

- 画面の目視確認は Cloudflare Access の OTP が必要なため、所有者のブラウザで行う。
- 「操作する人」は上記のとおりデモ表示。実利用者の表示への切替は別件。
- 旧部署コードは `selectable=false` で残る。API は旧コードも受け付ける（旧クライアント互換）。
