# みらいソフトウェアファクトリー — 受付ステーション MVP

- Repository: https://github.com/Kensan196948G/Software-Factory （private）
- 検証環境: https://sf.mirai-dx-platform.com （Cloudflare Access・ワンタイムパスワード・12時間）
- 保存場所: `/mnt/storage/Software-Factory/Software-Factory`

みらい建設工業の「困りごと」を受け付け、信号の色（青・黄・赤）と合格の条件を整え、承認済みの注文書として開発ラインへ渡すまでの**受付ステーション**MVPです。

- 正本の要件: `docs/みらいSF 要件定義書 V1.0.html`（MSF-REQ-2026-001）
- 正本の仕様: `docs/みらいSF 詳細仕様書 V1.0.html`（MSF-SPC-2026-001）
- 本リポジトリの実装範囲: `docs/project/01-mvp-scope.md`

## 目的と利用者

| 項目 | 内容 |
|---|---|
| 目的 | 要望の入口を1つにし、信号の色・合格の条件・承認を記録して、検査可能な注文書にする |
| 利用者（MVP） | 個人利用者1名。依頼者・受付担当・承認者の3役を兼ね、画面のロール切替で確認する |
| 主要フロー | ①依頼を登録する ②承認する（信号決定・承認前チェック） ③進める・差し戻す・見る |
| WebUI | `offline-Application/mirai-construction-sf-console.html`（原本）をそのまま採用。受付データは API/DB と同期する（`src/web/public/bridge.js`） |
| 開発ライン連携 | 承認済み注文書のYAML生成・コピーに加え、GitHub Issue を自動作成（`POST /api/requests/:id/handoff`） |

## 構成

```
src/api/     Fastify + PostgreSQL（認証・受付・状態遷移・承認・監査・入出力）
src/shared/  ドメイン（信号・合格の条件・ものさし・遷移・注文書YAML・CSV）
src/web/     受付・運用コンソール（原本 + APIブリッジ）
db/          migration / seed（19部署・118道具・見本9件）
tests/       unit / integration / e2e
docs/        要件・仕様・設計・DB・API・テスト・デプロイ・制限
```

## セットアップ（ローカル）

前提: Node.js 22、pnpm 10、PostgreSQL 16（ローカル、unix socket もしくは 127.0.0.1）。

```bash
# 1. 依存関係
pnpm install

# 2. DB とロール（初回のみ。既存ロールは変更しない）
createuser -s mirai_sf_app 2>/dev/null || true
createdb -O "$USER" mirai_sf_dev
createdb -O "$USER" mirai_sf_test

# 3. ローカル設定（ワークスペース外に 0600 で作成。秘密情報をリポジトリに置かない）
node scripts/bootstrap-local.mjs

# 4. migration と seed
pnpm db:migrate
pnpm db:seed
pnpm db:verify

# 5. 開発サーバ（API: 8781 / Web: 5178）
pnpm dev
```

初期管理者のメールアドレスとパスワードは `scripts/bootstrap-local.mjs` が表示します（`~/.config/mirai-sf/local.json` に保存）。**初回ログイン後に変更してください。**

## 検証

```bash
pnpm typecheck      # 型チェック（API + Web）
pnpm lint           # ESLint
pnpm test           # unit + integration
pnpm test:e2e       # Playwright（承認後に有効化）
pnpm build          # API + Web ビルド
pnpm db:verify      # DB の整合性（19部署/118道具/採番/監査ハッシュ連鎖）
```

## 環境変数

`scripts/local-run.mjs` が `~/.config/mirai-sf/local.json` を環境変数として注入します。主なキー:

| キー | 用途 |
|---|---|
| `DATABASE_URL` / `MIGRATION_DATABASE_URL` | アプリ用 / migration 用の接続文字列 |
| `TEST_DATABASE_URL` | 結合テスト用（`mirai_sf_test`） |
| `SESSION_SECRET` | セッション（将来の署名用） |
| `ORIGIN_SHARED_SECRET` / `REQUIRE_ORIGIN_SECRET` | Cloudflare Worker → origin の共有秘密 |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | 初期管理者（seed 時のみ） |
| `ALLOW_SELF_APPROVAL` | 個人MVPの自己承認許可（本番は false） |

## 認証（検証環境）

- 前段: Cloudflare Access（`@mirai-const.co.jp` を許可、ワンタイムパスワード、セッション12時間）。
- アプリ: `AUTH_MODE=access` で Access の認証ヘッダを信頼（パスワード画面は表示しない）。
- ローカル開発: `AUTH_MODE=password`（`scripts/bootstrap-local.mjs` の初期管理者）。

## セキュリティ

- 秘密情報はリポジトリ・ログ・Seed・画面に保存しない。
- ローカル PostgreSQL をインターネットへ直接公開しない（Cloudflare Tunnel 経由）。
- 認証は scrypt、HttpOnly/SameSite Cookie、CSRF トークン、Origin 検証、ログイン試行制限。
- 監査ログは追記のみ（UPDATE/DELETE をトリガで拒否）・ハッシュ連鎖。

## ドキュメント

- [初動Assessment](docs/project/00-assessment.md)
- [MVP Scope](docs/project/01-mvp-scope.md)
- [Planning](docs/project/02-plan.md)
- [WebUI設計（OpenDesign）](docs/project/03-design.md)
- [データベース](docs/database.md)
- [API](docs/api.md)
- [テスト](docs/test.md)
- [デプロイ・復旧](docs/deployment.md)
- [既知の制限](docs/limitations.md)

## ライセンス

社内標準・社外秘（みらい建設工業株式会社）。第三者への公開はしない。
