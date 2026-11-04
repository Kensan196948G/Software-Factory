# 他リポジトリ連携の現状評価（2026-11-04 実測）

対象: `docs/devline/development-dispatcher-integration.md`（相手: `Kensan196948G/Development-Dispatcher`）の前提と未決事項。
実施: 開発ライン（他リポジトリ連携）担当。**読取のみ**（clone・配備・systemctl の操作・Cloudflare の操作・本番 DB への書込みはしていない）。
秘密情報（トークン・接続文字列・実メール・注文書の実データ）は確認も出力もしていない。以下の「設定済みか」は**キーの有無と空否だけ**で、値は見ていない。

## 1. 結論（先に要点）

| #   | 事実                                                                                                                                                                     | 影響                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1   | Development-Dispatcher は**このホストに配備済み**（ローカルのプレビュー。`127.0.0.1:8750` で `readyz` が 200）。文書の「未配備」は**古い**                                        | 文書 1 章の前提を更新する必要がある（ただし実装を足す判断は別。§5）                                        |
| 2   | 相手の API は **REST + OpenAPI 3.1**（`/api/v1/jobs` ほか）。**非同期のジョブ受付**で、SF から見た進捗は `GET /api/v1/jobs/{job_id}` のポーリング                            | 未決「API の形」は判明。SF→DD の**webhook は無い**（受信口は ACCC と GitHub の webhook だけ）              |
| 3   | 認証は**共有鍵（サービスキー）または Cloudflare Access**。mTLS ではない。未認証の `/api/v1/jobs` は 401                                                                  | 未決「認証方式」は「共有秘密ヘッダ」に寄せる（文書の mTLS 案は採らない）                                   |
| 4   | 相手の受付契約（`packages/contracts/job-request.schema.json` v1）は**JSON の開発依頼**（`request_id`・`idempotency_key`・`repository{owner,name,base_branch}`・`task{acceptance_criteria}`・`policy{risk_level}`）。**注文書 YAML を受け取る形ではない** | 文書 3 章の「注文書 YAML を渡す」は**そのままでは実装できない**。YAML → JSON の写像を先に決める           |
| 5   | 相手は**マージ・デプロイをしない**（README・ADR-0007）。PR まで                                                                                                                                                                          | 文書 2 章の役割分担どおり。SF が merge と配備を持つ前提は維持できる                                        |
| 6   | 相手の状態は **pre-merge・本番未稼働**（README のバッジ、ADR-0009 は Proposed）。SF との接続は**仮定**（ADR-0009 に明記）                                                 | 「相手の契約が確定してから SF 側のコードを書く」という文書 7 章の判断は**維持**する                        |
| 7   | SF 側の設定: `DEVLINE_TARGET_REPOS` は **preview だけ設定済み（1 件）**。`prod.conf`・`prodr.conf`・`local.json` には**無い**＝本番の投入は全て ERR-405。`DEVLINE_REPO_LEDGER` は環境変数ではなく**コード定数**（1 件＝Sandbox のみ） | 本番で投入するには台帳＋設定＋対象 repo の CI（`ac-results` v2／`image`）とブランチ保護が要る（`repo-onboarding.md`） |
| 8   | SF の `src/` に Dispatcher を呼ぶコードは**0 件**（`Dispatcher`/`dispatcher` で grep）                                                                                   | 文書「コードを書かない」は守られている。今回の PR でも足さない                                            |

## 2. 実測（このホスト）

### 2-1. リポジトリ

| 確認                                                                        | 結果                                                                  |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `gh repo view Kensan196948G/Development-Dispatcher`                         | `PRIVATE`、既定ブランチ `main`、`pushedAt` 2026-11-03T17:46:49Z       |
| `gh api repos/.../contents`（clone せず）                                   | `apps/` `packages/` `infra/` `docs/` `tests/` `tools/` `examples/` `.github/` ほか |
| `apps/`                                                                     | `api`（Python 3.12 / FastAPI 系。`uvicorn dd.main:app` で起動）        |
| `packages/`                                                                 | `contracts`（JSON Schema）・`policy`                                   |
| `infra/`                                                                    | `db` `migrations` `native`（systemd の unit）                          |
| `.github/workflows/`                                                        | `ci.yml` 1 本                                                         |
| `docs/adr/`                                                                 | 0001〜0011（`0009-integration-contract.md` が今回の対象）              |

### 2-2. 配備（このホストの systemd ユーザー unit。**状態を見ただけ**）

| unit                     | 状態     | 役割（unit の Description から）                                              |
| ------------------------ | -------- | ----------------------------------------------------------------------------- |
| `dd-api.service`         | active   | API（`127.0.0.1:8750`、`uvicorn dd.main:app`、`~/.local/share/dd/current`）    |
| `dd-worker.service`      | active   | 制御ループ（lease・retry・outbox・PR の照合）                                  |
| `dd-executor.service`    | active   | 実行（bubblewrap の中でエージェントを動かす）                                  |
| `dd-cloudflared.service` | active   | Cloudflare Tunnel（`dd.mirai-dx-platform.com`）                                |
| `dd-swagger.service`     | active   | Swagger UI（`127.0.0.1:8760`。ループバックのみ）                               |
| `dd-backup.timer`        | waiting  | 日次の DB バックアップ                                                         |
| `dd-health.timer`        | waiting  | 5 分ごとの health（readyz・outbox・dead letter・監査の連鎖）                   |
| `dd-restore-drill.timer` | waiting  | 週次の復元訓練                                                                 |

- `GET /readyz` → `200 {"status":"ready","version":"0.1.0"}`。`GET /api/v1/jobs`（認証なし）→ `401`。
- 待受は `127.0.0.1:8750`（API）と `127.0.0.1:8760`（Swagger）だけで、公開ポートは無い（外向きは Tunnel 経由）。
- **本番稼働ではない**（README のバッジ `production: not deployed`、ADR-0009 は `Proposed`）。

### 2-3. API の形（`docs/api/openapi.yaml` と実際の `/openapi.json` で一致）

| メソッド・パス                                | 用途                                             |
| --------------------------------------------- | ------------------------------------------------ |
| `POST /api/v1/jobs`                           | 開発依頼の受付（`job-request` v1）。認証必須     |
| `GET /api/v1/jobs`                            | 一覧                                             |
| `GET /api/v1/jobs/{job_id}`                   | 1 件（進捗のポーリング先）                       |
| `POST /api/v1/jobs/{job_id}/cancel`           | 取消                                             |
| `POST /api/v1/jobs/{job_id}/retry`            | 再試行                                           |
| `POST /api/v1/jobs/{job_id}/approval`         | 承認                                             |
| `GET /api/v1/jobs/{job_id}/artifacts`         | 成果物                                           |
| `GET /api/v1/providers/health`                | 実行先（Claude Code / Codex）の健康              |
| `GET /api/v1/metrics`                         | 指標                                             |
| `POST /api/v1/workers/{worker_id}/quarantine` | worker の隔離                                    |
| `GET /api/v1/audit/verify`                    | 監査の連鎖の検証                                 |
| `POST /api/v1/integrations/github/webhook`    | GitHub からの受信                                |
| `POST /api/v1/integrations/accc/events`       | ACCC からの受信                                  |

受付契約（`packages/contracts/job-request.schema.json`、`urn:dd:contracts:job-request:v1`）:
`request_id`・`idempotency_key`（8〜200 字）・`organization_id`・`repository{owner,name,base_branch}`・`task{issue_number?,title?,description?,acceptance_criteria[]}`・`policy{risk_level(LOW〜CRITICAL), approval_reference?, data_classification?}`・`execution{preferred_provider(auto|claude-code|codex), max_wall_seconds, max_cost_usd, max_tokens?}`。`additionalProperties: false`。
冪等キーは**本文の `idempotency_key`**（ヘッダではない）。費用の上限は **USD**（`max_cost_usd`）。

### 2-4. SF 側の設定（値を出さずに有無だけ）

| 項目                                       | 確認結果                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 許可台帳 `DEVLINE_REPO_LEDGER`             | `src/shared/devline.ts` の**コード定数**。環境変数ではない。1 件（Sandbox のみ、`private: true`）  |
| `DEVLINE_TARGET_REPOS`（preview.conf）      | **設定済み・非空（1 件）**（`owner/name:repoId` の形。値は出さない）                              |
| `DEVLINE_TARGET_REPOS`（prod.conf / prodr.conf / local.json） | **キーが無い**＝本番の新規投入は全て ERR-405（意図どおり fail-closed）              |
| `DEVLINE_RUNNER_KIND`（preview.conf）       | 設定済み（非空）                                                                                 |
| `~/.config/mirai-sf/devline-secrets.env`   | 0600。`DEVLINE_GITHUB_TOKEN` は**設定済み（非空）**。`ANTHROPIC_API_KEY` も有り（値は見ていない） |
| SF の `src/` に Dispatcher の呼び出し       | **0 件**                                                                                          |

## 3. 未決事項への現状評価（文書 6 章）

| 未決事項                           | 現状（2026-11-04）                                                                                                                                                                   | 評価                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatcher の実行範囲              | 実装・テスト・独立レビュー・PR 作成まで。**マージとデプロイはしない**（README・ADR-0007）。ACCC の実行判定に従う                                                                      | **決まった**（SF の役割分担どおり。合否は引き続き SF が CI と `ac-results` v2 で独立に確かめる）                                              |
| API の形（REST / キュー / gRPC）   | **REST + OpenAPI 3.1**。受付は `POST /api/v1/jobs` の**非同期**、進捗は `GET /api/v1/jobs/{job_id}` のポーリング。SF 向けの通知（webhook）は無い                                        | **決まった**（SF 側は「送る → ポーリング → 照合」で作る。タイムアウトとリダイレクトを追わない既存の流儀に合わせる）                            |
| 認証方式                           | `DD_AUTH_MODE`＋`DD_SERVICE_KEYS_JSON`（**共有鍵**）または Cloudflare Access。ACCC へは HMAC の受信秘密（`DD_ACCC_INBOUND_SECRET`）。mTLS の口は無い                                   | **決まった**（SF は**共有秘密のヘッダ**。秘密は `~/.config/mirai-sf/` に置き、URL・ログ・監査に出さない。文書の mTLS 案は採らない）            |
| 費用の計上                         | 相手は `max_cost_usd`（USD）と `max_wall_seconds` を受ける。SF の上限は**円**（1,000 円/タスク）                                                                                     | **未決のまま**。換算（為替）と、どちらが上限を強制するかを決める。案: SF が円で判定し、その時点の換算で `max_cost_usd` を渡して二重に持つ        |
| 実行中の heartbeat と取消          | 取消は `POST /api/v1/jobs/{job_id}/cancel` がある。worker 側は lease で回り、**SF から見える heartbeat の API は無い**（`GET /jobs/{id}` のポーリングだけ）                              | **部分判明**。SF 側の lease・タイムアウトで止め、取消 API を呼ぶ形にする。heartbeat の間隔は相手と決める                                      |
| 成果物（image / ac-results）の扱い | `GET /api/v1/jobs/{job_id}/artifacts` はあるが、SF の `msf.image/v1` と `ac-results` v2 の形式で出るかは**未確認**（相手の CI は対象 repo 側の話）                                     | **未決のまま**。SF は**対象 repo の CI の artifact だけ**を根拠にする方針を維持する（相手の申告を合格にしない）                                |

### 3-1. 文書 3 章の「受け渡し」との差分（実装前に直す）

| 文書の案                                                    | 相手の実際                                                                                       | 必要な作業                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 注文書（YAML）を渡す                                        | JSON（`task.acceptance_criteria[]`・`policy.risk_level`）                                        | 注文書 YAML → `job-request` v1 の**写像**を決める   |
| 冪等キーは「job ID + 試行番号」                              | 本文の `idempotency_key`（8〜200 字、`[A-Za-z0-9_.:-]`）                                          | `<jobId>:<attemptNo>` を詰める等の規則を決める      |
| 対象 repo は `owner/name:repoId`                            | `repository{owner,name,base_branch}`（**repoId は渡さない**）                                     | repoId は SF 側の照合にだけ使う（相手には渡さない） |
| SF → Dispatcher に `base SHA`・`job の版` を渡す             | 受付契約に `base_sha` と版の欄が無い                                                              | 受付後に相手が決める。SF は結果の head SHA で照合   |
| 費用は「1,000 円/タスクをどちらが強制するか」                 | 上限は USD                                                                                        | 換算の規則を決める（上表の未決）                     |

## 4. 連携候補のリポジトリ（評価用。名簿のみ）

`gh repo list Kensan196948G --limit 100` の結果から、**非公開**かつ最近動いているものを抜いた（公開リポジトリは L-14 により投入先にできない）。

| リポジトリ                         | 公開範囲 | 最終 push（UTC）      | 所見                                                                                     |
| ---------------------------------- | -------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `Software-Factory-Sandbox`         | private  | 2026-11-03T04:11:53Z  | **唯一、台帳と設定に載っている**投入先（検証用）                                          |
| `Development-Dispatcher`           | private  | 2026-11-03T17:46:49Z  | 相手。SF の投入先にはしない（役割が逆）                                                   |
| `dd-e2e-sandbox`                   | private  | 2026-11-03T08:47:53Z  | 相手の E2E 用。SF の投入先にするかは相手の CI 形式しだい                                  |
| `AI-Company-Control-Center`        | private  | 2026-11-03T13:44:31Z  | ACCC。相手の上位。SF の投入先にはしない                                                   |
| `RIHRP-Research-Studio`            | private  | 2026-11-03T13:44:31Z  | 2 つ目の投入先の候補。CI（`ac-results` v2・`image`）とブランチ保護の用意が要る            |
| `Civil-IT-Operation-Enterprised-Platform` | private | 2026-11-02T00:14:26Z | 候補。同上                                                                                |

公開（`Civil-Cost-Index-Dashboard`・`AI-HelpDesk-Platform` ほか）は L-14 により**対象外**（例外の設定は作らない）。

## 5. 判断（今回やらないこと）

1. **Dispatcher を呼ぶコードは足さない。** 相手は pre-merge（ADR-0009 は `Proposed`）で、受付契約と注文書の写像が未確定。動かない経路を本番の設定に混ぜない（文書 1 章・7 章の判断を維持）。
2. **clone しない・配備しない・unit を操作しない。** 今回は `gh api` と `systemctl --user list-units`・`curl`（ループバック）だけ。
3. 費用の換算と成果物の形式は**未決のまま**残す（決めるのは所有者）。

## 6. 再確認のしかた（次回）

```bash
gh repo view Kensan196948G/Development-Dispatcher --json name,visibility,defaultBranchRef,pushedAt
gh api repos/Kensan196948G/Development-Dispatcher/contents/docs/adr/0009-integration-contract.md --jq .content | base64 -d
systemctl --user list-units --all | grep -i '^ *dd-'
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8750/readyz
```

値の確認が要るときも、`~/.config/mirai-sf/*.conf` と `devline-secrets.env` は**キーの有無と空否だけ**を見る（値を画面・ログ・PR・チャットに出さない）。
