# 本番の開発ライン自動化（`DEVLINE_ALLOW_PRODUCTION`）

状態: 実装済み（2026-11-18）。既定は**拒否**で、所有者が `DEVLINE_ALLOW_PRODUCTION=1` を明示したときだけ、本番でも開発ラインの実 runner と自動マージを動かせる。

## 1. 決定

- 所有者の指示（2026-11-18）: **全段階の自動移動と、commit から merge までの全自動**を、本番でも明示の許可で行えるようにする。
- 2026-11-01 の決定（「本番では実 runner を起動しない」）は**既定としては維持する**。変更したのは「本番では絶対に不可」ではなく「所有者の明示許可があるときだけ可」にした点だけである。
- 許可の単位は環境変数 1 つ（`1`）で、作業・依頼ごとの許可ではない。**値を設定した環境では、以後すべての開発ラインの作業が本番で自動化される**。
- **fake は許可しない。** 本番で作り物の CI を通す経路は、この設定でも開けない（別の明示許可も作らない）。

## 2. 変更した判定

| 判定                             | 場所                                                    | 変更前                                       | 変更後                                                      |
| -------------------------------- | ------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| 実 runner の起動（worker）       | `src/worker/loop.ts` `assertRunnerAllowed`              | 本番では `docker-claude` を拒否              | `DEVLINE_ALLOW_PRODUCTION=1` のときだけ許可                 |
| 実 runner の起動判定（設定だけ） | `src/worker/real-line.ts` `checkRealLineEnv`            | 本番は常に拒否                               | 明示許可のときだけ次の検査（台帳・repo・差分 policy）へ進む |
| 自動マージの設定                 | `src/api/devline-real-config.ts` `parseAutoMergePolicy` | 本番では `DEVLINE_AUTO_MERGE=1` でも起動拒否 | 明示許可のときだけ有効にできる                              |
| 起動設定の解釈                   | `src/api/config.ts` `devlineAllowProduction`            | （なし）                                     | 未設定・空・`0` は無効、`1` は有効、それ以外は起動エラー    |

- 読み口は 2 つあるが、どちらも**同じプロセス環境**の `DEVLINE_ALLOW_PRODUCTION` だけを見る（`AppConfig.devlineAllowProduction` と、環境変数を直接読む純関数）。JSON 設定ファイル・overrides は見ないので、片方だけ許可・拒否という状態にならない。
- 設定の置き場は systemd の `EnvironmentFile`（Staging は `preview.conf`、本番は `prod.conf`）。**API と worker の両方**に同じ値を渡す。フラグの値は環境に関係なく起動時に検証し、`0` / `1` 以外は起動エラーにする。

## 3. 明示許可でも変わらないこと

- 対象リポジトリは、コードの許可台帳（`DEVLINE_REPO_LEDGER`）と `DEVLINE_TARGET_REPOS` の**積集合**にある非公開リポジトリだけ。repoId の一致と差分 policy も従来どおり必要（`docs/devline/repo-onboarding.md`）。
- 検証の根拠は CI の結果だけ。`source=fake_ci` は本番で拒否する（`src/api/devline-verification.ts`）。
- 自動マージの 6 条件（検証 `passed`、台帳、差分証跡、注文書が最新版、PR の head 一致、人の merge が進行中でない）は変わらない。ブランチ保護（Required Checks）が無い間は有効にしない（`docs/devline/real-runner.md` §17）。
- 人の承認の経路（`POST /api/jobs/:id/approve-merge`）は残る。自動マージはその代替ではなく、機械判定として監査に残る。
- 取り込み（`ERR-405`）の他の拒否理由（資格情報の 0600・`DEVLINE_GITHUB_TOKEN`・予算・接続先）は変わらない。

## 4. 有効化と戻し

**このフラグはプロセス環境（systemd の `EnvironmentFile`）だけを見る。** `local.json` などの JSON 設定ファイルや overrides では有効にならない（設定ファイルの置き忘れで本番が有効にならないように）。API と worker の両方へ同じ値を渡す。

### 4-1. Staging で試す（`preview.conf`）

```ini
# ~/.config/mirai-sf/preview.conf（API と worker の両方が読む）
DEVLINE_WORKER_ENABLED=1
DEVLINE_RUNNER_KIND=docker-claude
DEVLINE_TARGET_REPOS=<owner/repo:repoId>
DEVLINE_SECRETS_FILE=<資格情報の絶対 path>
DEVLINE_ALLOW_PRODUCTION=1
# 自動マージまで行う場合だけ。行内コメントは書かない（systemd の EnvironmentFile では値の一部になる）
DEVLINE_AUTO_MERGE=1
```

```bash
systemctl --user daemon-reload
systemctl --user restart mirai-sf-api.service mirai-sf-worker.service
journalctl --user -u mirai-sf-worker.service -n 30   # 起動の拒否理由が出ていないこと
```

### 4-2. 本番で有効化する（未整備・別作業）

本番は `prod.conf`（`mirai-sf-prod-api.service`）で動く。**本番用の worker の unit はリポジトリにも現行の systemd にも無い**ため、`DEVLINE_ALLOW_PRODUCTION=1` を置くだけでは本番の全自動化は動かない。必要な作業:

1. 本番用 worker の unit（例: `mirai-sf-prod-worker.service`）を `deploy/systemd/` に追加し、実機へ導入する。`deploy/**` の変更は人間の承認が要る（`R4`）。
2. `~/.config/mirai-sf/prod.conf` に、上の `preview.conf` と同じ変数を置く（`DATABASE_URL` は本番用のまま。資格情報の path も本番用）。
3. API と本番 worker を再起動し、`journalctl` で拒否理由が出ていないことを確認する。

この unit 追加は本 PR の範囲外である（本 PR は判定の切りかえだけ）。

### 4-3. 戻す

`DEVLINE_ALLOW_PRODUCTION` の行を消す（または `0`）→ 再起動。以後の起動判定は拒否に戻る。すでに merge 済みのものは戻らない（merge の取消はしない）。

## 5. 監査・記録

- 自動マージの判定理由・根拠の run・設定値は、従来どおり `release` と監査に残る（`docs/devline/real-runner.md` §17）。
- 許可の値そのものはリポジトリに置かない（`preview.conf` は非公開・0600）。有効化した事実は、配備の記録と `docs/production/26-release-status.md` に残す。
- 起動の拒否は worker のログに出る（`production では ... DEVLINE_ALLOW_PRODUCTION=1 で明示許可できます`）。無言で止まらない。

## 6. 残リスク

- **本番の merge が AI の成果物に対して自動で進む。** 条件と保護は従来どおりだが、人が merge を押さない運用になるため、監視（`mirai-sf-prod-healthcheck`・失敗の通知）と、定期的な PR・監査の確認が前提になる。
- 設定は環境全体に効く。**作業単位で止めたいときは値を消して再起動**するしかない。
- 起動時に一度だけ読む。実行中に値を変えても反映されない（再起動が必要）。
- 本番でまだ実走していない（2026-11-18 時点）。初回は対象を 1 リポジトリ・1 依頼に絞り、PR と監査を人が確認する。

## 7. 参照

- `docs/devline/real-runner.md`（§6 環境変数、§17 自動マージ）
- `docs/devline/repo-onboarding.md`（台帳・差分 policy・ブランチ保護）
- `docs/limitations.md` L-15
- 実装: `src/api/config.ts`、`src/api/devline-real-config.ts`、`src/worker/real-line.ts`、`src/worker/loop.ts`
