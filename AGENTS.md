# AGENTS.md — みらいSF 受付ステーション

このリポジトリで作業するAIエージェント（DeepSeek Harness / Claude Code / Codex 等）向けの指示です。
中央の `GITHUB_POLICY.md`（main直接push禁止・Required Checks・Squash Merge）に優先されます。

## 1. 目的と範囲

- 目的: みらい建設工業の「受付ステーション」MVP（要望受付 → 信号判定 → 承認 → 注文書YAML → 進捗管理）を、個人利用できる形で動かす。
- 範囲: `docs/project/01-mvp-scope.md` の In Scope。開発ライン本体（AI実装・CI・PR自動化）、本番環境、Entra ID SSO、通知連携は**対象外**（Issue化してBacklogへ）。
- 仕様の正本: `docs/みらいSF 詳細仕様書 V1.0.html`。画面ID（SCR-xx）・状態・エラーコード（ERR-xxx）・データ項目（ENT-xx）を勝手に変えない。変える場合は理由と影響を `docs/` に記録し、承認を得る。

## 2. 禁止事項（違反したら作業を止める）

1. 本番データ・個人情報・発注者から預かった図書・写真の原本を、開発環境・DB・Seed・テスト・ログ・AIへ持ち込まない。**作り物のデータだけ**を使う。
2. Secrets（パスワード・トークン・接続文字列）をリポジトリ、commit、PR、ログ、画面、Seed、Memoryへ書かない。ローカル設定は `~/.config/mirai-sf/local.json`（0600）に置く。
3. 破壊的DB操作（`DROP DATABASE` / `DROP TABLE` / `TRUNCATE` / 大量DELETE / 不可逆migration）を、明示的な承認なしに実行しない。`reset` は `_dev`/`_test` かつ `--yes` のみ。
4. main へ直接 push しない。force push・`--admin` マージ・保護ルール回避をしない。
5. 既存の仕様・設計・ユーザー変更を、理由なく revert / 上書き / 削除しない。
6. 本番環境・Cloudflare Production・課金・契約・権限の重大変更を、承認なしに行わない。

## 3. ブランチ・コミット・PR

- ブランチ: `auto/<slug>`（例: `auto/intake-mvp`）。
- コミット: Conventional Commits（`feat:` / `fix:` / `docs:` / `test:` / `chore:` / `refactor:`）。
- PR本文: 目的 / MVP範囲 / 変更 / UI影響 / API影響 / DB影響 / Security影響 / テスト結果 / CI結果 / Deployment結果 / 既知の制限 / Rollback。
- Required Checks が緑・未解決レビューなし・Critical/Highなしのときだけ Squash Merge。

## 4. 変更の進め方

1. 変更前に `docs/` の該当仕様を読む。
2. WHY / WHAT / HOW / VERIFY を決めてから編集する。
3. 変更後に関連テストを実行する（下記）。
4. DBを変えたら migration を追加（additive）し、`db:verify` と空DBからの再構築を確認する。
5. UIを変えたら設計成果物（`docs/design/msf-intake-design.html`）との差異を確認し、差異を記録する。

## 5. 検証コマンド

```bash
pnpm typecheck
pnpm lint
pnpm test          # unit + integration（mirai_sf_test を使用）
pnpm test:e2e      # Playwright
pnpm build
pnpm db:verify
```

**未実施・失敗・skip のテストを成功として報告しない。** 実行できない場合は理由と代替検証を明記する。

## 6. 環境

| 項目       | 値                                                                                 |
| ---------- | ---------------------------------------------------------------------------------- |
| Node       | 22 以上                                                                            |
| PostgreSQL | 16（`mirai_sf_dev` / `mirai_sf_test`）                                             |
| API        | `127.0.0.1:8781`（`pnpm dev:api`）                                                 |
| Web        | `127.0.0.1:5178`（`pnpm dev:web`、`/api` を 8781 へプロキシ）                      |
| Preview    | `https://sf.mirai-dx-platform.com`（Cloudflare Tunnel + Access）→ `127.0.0.1:8782` |
| 設定       | `~/.config/mirai-sf/local.json`（`node scripts/bootstrap-local.mjs` で生成）       |

## 7. リポジトリ

- GitHub: `Kensan196948G/Software-Factory`（public。2026-10-31 所有者が公開継続を選択。社内資料・個人情報・秘密をコミットしない）
- 保存場所: `/mnt/storage/Software-Factory/Software-Factory`（旧 `/home/kensan/Projects/Software-Factory-Project` は symlink）

## 8. 既知の制限（詳細は `docs/limitations.md`）

- 1ユーザー・3役の切替。自己承認は既定で許可（本番は SSO＋複数ユーザーで禁止）。
- 添付はメタ情報のみ。通知・Entra ID・AI実装・PR自動化は未実装。
- 数値目標は（案）。MVPの実測後に確定する。
