# 承認記録（WebUI仕様・追加要件）

日時: 2026-10-28 / 承認: ユーザー（Y）

## 1. 承認された内容

| # | 確認事項 | 回答 |
|---|---|---|
| Q1 | 端末 | PC中心（タブレット768pxまで） |
| Q2 | 認証 | 1ユーザー＋パスワード＋検証用ロール切替（加えて Cloudflare Access のワンタイムパスワード） |
| Q3 | 開発ライン連携 | 注文書YAMLの生成・コピーに加え、**GitHub Issue の自動作成も行う** |
| Q4 | 見本データ | 見本9件（リセット可） |
| Q5 | 画面範囲 | SCR-01〜08＋21 の9画面 |
| 最終 | 実装を進めてよいか | **Y** |

## 2. 追加要件（同日）

| 項目 | 内容 | 対応 |
|---|---|---|
| 保存場所 | `Mirai-AI-Storage /mnt/storage/Software-Factory` 内に新規ディレクトリ | `/mnt/storage/Software-Factory/Software-Factory` を作成し、リポジトリを移設（旧パスはsymlink） |
| リポジトリ名 | `Software-Factory` | GitHub を `Mirai-Software-Factory` → `Software-Factory` に改名（履歴・PR維持） |
| 公開範囲 | GitHub Privacy（private） | private を維持 |
| ドメイン | Cloudflare利用 / `sf.mirai-dx-platform.com` | Cloudflare Tunnel＋DNS＋Access で公開 |
| アクセス制御 | `@mirai-const.co.jp` を許可、ワンタイムパスワード | Access アプリ（OTP）＋ポリシー（email_domain） |
| 継続ログイン | 12時間 | Access の `session_duration: 12h` とアプリの `SESSION_TTL_HOURS=12` |

## 3. 承認後の変更点（設計への反映）

- 設計 §15 のOut of Scopeから「GitHub Issue自動作成」をIn Scopeへ移動（`POST /api/requests/:id/handoff`）。
- 認証は「アプリのパスワード」と「Cloudflare Access」の二層。プレビューでは Access のヘッダを信頼する `AUTH_MODE=access`（パスワード画面は表示しない）。
- 画面の注文書タブに「GitHub Issueを作成」ボタンを追加。

## 4. 承認後のスコープ外（変更なし）

Production正式環境、Entra ID SSO、通知、添付本体、AppSuite版UI、本番データ移行。
