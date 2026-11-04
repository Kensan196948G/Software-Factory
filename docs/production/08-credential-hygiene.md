# 資格情報の衛生（分離・ローテーション）と残存リスク

作成: 2026-11-04 JST。状態: **所見と手順の記録。設定は未変更**（所有者判断待ち）。

本書は、このホストの `systemd --user` 環境に資格情報が残っている所見と、影響・応急処置・恒久対策・ローテーション手順をまとめる。**値は本書・リポジトリ・ログ・PRに書かない。**

## 1. 所見（2026-11-04 実測）

- `systemctl --user show-environment` に、GitHub のトークンと Cloudflare の API トークンに相当する変数が残っていた。調査時に出力のマスキングを怠り、値が一度ツール出力・セッションログに現れた（§5）。本書には値を転記しない。「変数名のみ確認し、値は記録されていない」という旧記述は不正確だったため訂正する。
- 影響範囲: 同一ユーザーの任意のプロセスが `systemctl --user show-environment` で読める。ユーザー unit の子プロセスは既定で継承する。
- 実際に影響が出た例: `mirai-sf-autofollow.service` の `git fetch` が、失効済みの `GITHUB_TOKEN` を `gh auth git-credential`（`~/.config/gh/hosts.yml`）より優先して認証に失敗した（PR #81 で `UnsetEnvironment` により解消）。
- 一度、エージェントのツール出力に値が現れた（セッションログに残る）。**ローテーションを推奨する。**

## 2. 応急処置（実施済み）

- `mirai-sf-autofollow.service` に `UnsetEnvironment=GH_TOKEN GITHUB_TOKEN GITHUB_PAT_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN` を追加し、認証を gh の hosts.yml に一本化した。
- 他の unit は未対応。user manager の環境自体は変わっていない。

## 3. 恒久対策（案。実施は所有者判断）

1. user manager の環境から秘密を外す: `systemctl --user unset-environment <NAME>...`（恒久化は `~/.config/environment.d/` からも削除）。
2. 必要なサービスだけが読む: 各 unit に
   `EnvironmentFile=%h/.config/mirai-sf/<service>.env`（0600、所有者のみ）を追加し、`Environment=` へ直書きしない。
3. 影響確認: `mirai-sf-worker`（GitHub 連携）・`dd-*`（Development-Dispatcher）など、外すと止まる unit を先に列挙し、EnvironmentFile を用意してから外す。
4. 確認: 生の `show-environment` や `show -p Environment` の出力をツール・端末ログへ表示しない。確認プログラム内で標準出力・標準エラーを捕捉し、変数名だけに変換してから報告する。値が必要な比較もプログラム内部で行い、結果の真偽だけを出す。`EnvironmentFile` に移しても、同一ユーザーや特権プロセスからの読取りを防ぐものではない。再起動後の health/ready と必要機能も実測する。

## 4. ローテーション手順（所有者が実施）

1. 影響範囲の特定: どの unit / スクリプトがそのトークンを使うか確認する。検索はファイル名と変数名だけを返し、設定行や値を表示しない（一般的な `grep -r` の行出力は使わない）。
2. 新トークン発行: GitHub は fine-grained PAT（対象リポジトリを最小化、`Contents: read` 等の必要権限のみ）。Cloudflare は対象アカウント・必要スコープのみ。**UI 作業が必要**。
3. 配備: `~/.config/mirai-sf/<service>.env`（0600）へ新値を置き、`daemon-reload` → 該当 unit を再起動。`gh auth login` を使う経路は `~/.config/gh/hosts.yml` を更新。
4. 検証: 該当機能の実測（fetch / PR 作成 / R2 送信 / healthcheck）。失敗時は旧値へ戻せるよう、切替前のファイルを 0600 で退避する。
5. 失効: 旧トークンを GitHub / Cloudflare 側で失効。失効後に再度 3〜4 を確認。
6. 記録: 実施日時・対象・実測結果のみを本書へ追記（値は書かない）。

## 5. 現時点の残存リスク

- user manager 環境に秘密が残る限り、同一ユーザーで動く任意のプロセス・エージェントから読める。
- セッションログ（ローカル）に値が一度現れている。ホスト外へ持ち出さない運用が前提だが、ローテーションまでリスクは残る。
- 「どの unit がどの変数に依存しているか」の棚卸しは未完了。恒久対策の前提として必要。

## 6. やらないこと

- 値を本書・PR・チャット・Issue に転記しない。
- 所有者の確認なく本番サービスの環境を一括で外さない（停止リスク）。
