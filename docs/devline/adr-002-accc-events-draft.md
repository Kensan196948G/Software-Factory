# ADR-002（草案）: 開発ラインのイベントを ACCC へ送る契約

状態: **Proposed（草案・未採択）**。実装・設定・送信は未実施。
作成: 2026-11-06 JST。担当: integration-scout（読み取り専用調査）。決定者: 所有者。

## 1. 背景

- Software-Factory（以下 SF）の開発ラインは、注文書 YAML の生成・PR 作成・CI ゲート・自動マージまでを扱う。
- 他リポジトリのうち `AI-Company-Control-Center`（以下 ACCC）は、外部からのイベント受信を実装済みである。
- 2026-11-06 時点で **SF 側に送信実装は無い**（`src/` の参照 0 件）。したがって SF の開発ラインの結果は、ACCC のポートフォリオ・原価・ケース管理へ反映されない。

## 2. 受信側（ACCC）の実仕様（読取りで確定した範囲）

| 項目 | 内容 |
| ---- | ---- |
| 経路 | `POST /api/v1/integrations/events`。認可は service principal の `events:ingest` |
| 認証 | **HMAC-SHA256**（Bearer ではない）。ヘッダ `X-ACCC-Key-Id` / `X-ACCC-Timestamp` / `X-ACCC-Signature`（任意: `X-ACCC-Nonce` / `Idempotency-Key`） |
| 署名対象 | `{timestamp}.{nonce}.{METHOD}.{path}.{Idempotency-Key}.{sha256hex(body)}` |
| 時刻窓 | -300 秒〜+30 秒 |
| 冪等 | **body の `event_id`** が主キー。同一 id + 同一 payload + 同一送信元 → 200 `duplicate`、内容相違 → 409 `event_id_conflict`、新規 → 202 `accepted` |
| 失敗時 | 受信側 inbox が指数バックオフ（`min(300, 2^attempts)`）で再試行し、上限で DLQ。恒久エラーは即 DLQ |
| 本文上限 / レート | 1,000,000 B / 600 req/min/鍵 |

### 2-1. 重要制約（見落とすと「成功に見えて捨てられる」）

- `event_type` は `^[a-z0-9_.]+\.v[0-9]+$` に一致する必要があるが、**未知の種別は API が 202 で受理した後、worker の適用段階で恒久エラーとなり DLQ へ落ちる**。送信側は 202 を受けただけでは「反映された」と判断できない。
- 2026-11-06 時点で受信側が適用できる既知種別は次のとおり。
  - `development.job.{queued,started,progress,completed,failed,cancelled}.v1`
  - `development.cost.recorded.v1`
  - `harness.case.upserted.v1` / `harness.agent.status.v1` / `harness.exception.raised.v1`
- 必須 subject: job 系は `subject.job_id`、case 系は `subject.case_id`。
- `producer` は鍵 ID と一致し、`organization_id` は鍵に紐づく組織と一致する必要がある（不一致は 403）。

## 3. 決定案

### 3-1. 送るイベント（既知種別の範囲に限定する）

| SF の出来事 | 送る種別 | 備考 |
| ----------- | -------- | ---- |
| 受付 → 注文書 YAML 生成 | `harness.case.upserted.v1` | `case_id` は受付番号（`REQ-YYYY-NNNN`）。title / status / priority を写像 |
| 開発ラインの run 完了・失敗 | `development.job.completed.v1` / `.failed.v1` | `job_id`、`status`、`cost_usd`、`pull_request_url` |
| 実コストの確定 | `development.cost.recorded.v1` | 既存の原価契約に従う |

- **PR のマージ・承認に対応する種別は現時点で存在しない**。独立イベントにしたい場合は ACCC 側の種別追加（ACCC の PR 承認）が別途必要である。それまでは job の `pull_request_url` と case の status 更新で近似する。

### 3-2. 送信方式

- 既存の `mail_outbox`（migration 0003 / 0004 / 0007）と同じ outbox 方式にする。業務トランザクションと同じ Tx で 1 行積み、送信は worker が行う。**送信失敗で業務遷移を巻き戻さない。**
- 再送: 202 / 200 は成功。409 / 422 は恒久失敗として `dead`（業務は止めない）。429 / 5xx / timeout は指数バックオフで再送し、上限で `dead`。
- feature flag は既定 off（`DEVLINE_ACCC_EVENTS=0`）。off のとき送信 0 件（テストで固定）。

### 3-3. 実装単位（案）

1. `db/migrations/0017_accc_event_outbox.sql`（`event_id` unique、status、attempts、next_attempt_at）
2. `src/shared/accc-event.ts`（封筒生成・canonical JSON・HMAC 署名の純関数）
3. 送信点: `src/api/devline-handoff.ts`（注文書生成）、`src/api/devline-auto-merge.ts`（マージ）、run 完了点
4. `src/worker/accc-event-sender.ts`
5. 秘密: `DEVLINE_SECRETS_FILE` の許可名に `ACCC_EVENTS_SECRET` を追加（値はリポジトリ・ログへ出さない）
6. 設定キー名: `DEVLINE_ACCC_EVENTS` / `DEVLINE_ACCC_BASE_URL` / `DEVLINE_ACCC_KEY_ID` / `DEVLINE_ACCC_ORG_ID` / `DEVLINE_ACCC_MAX_ATTEMPTS`

## 4. 人間の承認が必要な項目（実装前に必要）

1. `AGENTS.md` §1 の範囲変更（現行は通知連携を対象外としている）。Issue 化して Backlog へ。
2. ACCC 側への SF の service principal 登録と鍵発行（鍵 ID・organization_id・`events:ingest`）。秘密値は人が設定する。
3. 送るイベントの範囲（PR マージ・承認を独立イベントにするなら ACCC 側の種別追加が必要）。
4. 本番 ACCC への到達経路（ACCC は Cloudflare Access 配下。HMAC のサービス呼び出しを Access に通すか、別経路にするか）。
5. feature flag の本番有効化。

## 5. 未確認（推測で埋めない）

- 本番 ACCC の実 URL と、Access 配下で HMAC 呼び出しが通るか（SF 側に送信実装が無く実測不能）。
- SF が送る `organization_id` の実値（鍵登録時に確定）。
- ACCC の `/ops/dead-letters` を SF の運用手順で監視するか。

## 6. 結論

- **条件付きで実装可能**。outbox + 署名純関数 + sender + flag off の範囲は SF 単独で実装でき、既定 off のため本番挙動を変えない。
- ただし上記 §4 の 5 項目が未決のまま本番有効化はできない。**本 ADR は草案であり、採択ではない。**
