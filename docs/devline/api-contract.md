# 開発ライン Phase 1 の契約（Dev と QA 用）

判断の理由は `docs/devline/adr-001-devline-foundation.md`（実装時に確定した差分は ADR 11章）。型・定数・純関数は `src/shared/devline.ts` にあり、ここと食い違うときは `devline.ts` と migration を正とする。契約を変えるときは Architect に戻す。`JobRow`・`JobPatch`（DB の行）は API 側の型なので Dev が定義する。

## 1. サービス層の関数

置き場所の案: `src/api/devline-service.ts`、`src/api/issue-adapter.ts`（GitHub 実装）、`src/worker/{main,loop,fake-runner,fake-ci}.ts`。`now` はすべて引数で受け、判断に `new Date()` や SQL の `now()` を使わない。

```ts
interface DevlineDeps {
  issueAdapter: IssueAdapter;       // 既定は GitHub 実装。テストはローカル fake を注入
  targetRepo: string;               // 既定は config.githubRepo。クライアントから受けない
  allowedRepos: readonly AllowedRepo[];  // DEVLINE_TARGET_REPOS（owner/name:repoId）。既定は空で投入をすべて拒否
  ledger?: readonly RepoAllowEntry[];   // 許可台帳。既定は DEVLINE_REPO_LEDGER。試験の差し替えだけが渡す
  now: () => Date;
  httpTimeoutMs?: number;           // 既定は HANDOFF_POLICY.httpTimeoutMs
}

// 版固定と投入
handoffOrder(
  input: { requestId: string; orderVersion: number | null; confirmAbsent?: { reason: string } },
  actor: Actor, correlationId: string, deps: DevlineDeps,
): Promise<HandoffResult>;

// 旧ルート。応答の形は変えない
handoffToGithub(id: string, actor: Actor, correlationId: string, deps?: DevlineDeps):
  Promise<{ issueNo: number; issueUrl: string; created: boolean; detail: RequestDetail }>;

freezeOrderSnapshot(client: PoolClient, input: {
  requestId: string; targetRepoId: string; baseSha: string; now: Date;
}): Promise<{ snapshotId: string; orderVersion: number; contentSha256: string; created: boolean }>;

// 読み取り
getJob(jobId: string, actor: Actor): Promise<JobView>;
listJobsForRequest(requestId: string, actor: Actor): Promise<JobView[]>;

// 人の操作
cancelJob(input: { jobId: string; reason: string; expectedState?: JobState },
  actor: Actor, correlationId: string, now: Date): Promise<JobView>;
resumeJob(input: { jobId: string; reason: string; expectedState?: JobState },
  actor: Actor, correlationId: string, now: Date): Promise<JobView>;

// worker 用（HTTP の外）
claimNextJob(input: { owner: string; now: Date; leaseSeconds?: number }):
  Promise<{ job: JobRow; lease: JobLease } | null>;
heartbeat(lease: JobLease, now: Date): Promise<FencedWrite<{ leaseExpiresAt: Date }>>;
releaseLease(lease: JobLease, now: Date): Promise<FencedWrite<null>>;  // 工程の終わりに必ず呼ぶ
transitionJob(lease: JobLease, input: {
  to: JobState; patch?: Partial<JobPatch>; detail?: unknown; now: Date; correlationId: string;
}): Promise<FencedWrite<JobLease | null>>;
haltJob(lease: JobLease, input: {           // 行き先は haltTarget(state, reason) で決める
  reason: StopReason; detail: unknown; remainingWork: unknown;
  now: Date; correlationId: string;
}): Promise<FencedWrite<null>>;
startAttempt(lease: JobLease, input: { step: RunnerStep; runnerKind: RunnerKind; now: Date }):
  Promise<FencedWrite<{ attemptId: string; attemptNo: number }>>;
finishAttempt(lease: JobLease, attemptId: string, result: RunnerResult, now: Date):
  Promise<FencedWrite<null>>;

// 検証証跡（in-process。HTTP にしない）
recordVerification(input: RecordVerificationInput): Promise<RecordVerificationResult>;

// PR 候補（pr_ready に入るトランザクションの中で作る）
buildPrCandidate(client: PoolClient, jobId: string, verdict: VerificationVerdict, now: Date):
  Promise<{ artifactId: string; sha256: string }>;
```

### handoffOrder の手順

1. 権限（`canHandoff`）。外れたら ERR-101 と監査（`result='denied'`）。`isRepoAllowed` に外れたら ERR-405。
2. 依頼を読む（無ければ ERR-104）。本文の `orderVersion` が `request.order_version` と違えば、intent の有無にかかわらず ERR-202。その版の intent があれば 6 へ。`sendAllowed` = 版が最新 かつ `isOrderCurrent`。
3. `checkOrderForHandoff`（最新の approval は `order by at desc, id desc limit 1`）。失敗はその code。
4. 前の版の intent を確かめる。create が `sent` / `unknown` なら先に照合。`intent` のままなら `failed` へ。
5. `resolveBaseSha`（外部呼び出しなのでトランザクションの外）。次にトランザクションで依頼を `for update`、3 を再検査、snapshot と intent を `on conflict do nothing` で入れて読み直す。op は `request.issue_no` か成功済みの intent があれば `update_issue`。commit。
6. `nextHandoffAction` で分岐する。

| 結果               | すること                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `return_existing`  | `created=false` で返す。job が無ければ確定をやり直す                                                                                                                                                                                 |
| `send_not_allowed` | 送らない。ERR-205（承認が取り消された。古い版は 2 で ERR-202 になる）                                                                                                                                                                |
| `in_flight`        | ERR-301                                                                                                                                                                                                                              |
| `retry_later`      | ERR-302（`details.nextAttemptAt`）                                                                                                                                                                                                   |
| `claim_and_send`   | `update ... set state='sent', attempts=attempts+1, sent_at=$now where id=$ and state=$現在値`。rowCount 0 や `handoff_intent_one_inflight_idx` の衝突は ERR-301。commit してから外部呼び出し（`AbortSignal.timeout(httpTimeoutMs)`） |
| `reconcile`        | 照合へ                                                                                                                                                                                                                               |

7. **照合**: create は `getActorLogin`、`listIssuesSince` を `nextPage` が尽きるか `reconcileMaxPages` まで回して `matchIssueByMarker`。update は `getIssue` で本文の1行目を比べる。読み取りの失敗は「走査が不完全」。見つかれば 8。無ければ `afterReconcileNotFound`。`stay_unknown` は ERR-304（`details.handoffState='unknown'`、`details.scanComplete`）。`resend_*` は `unknown → sent`。confirm_absent は `canConfirmAbsent` と理由（無ければ ERR-102）を確かめ、`confirmed_absent_*` と監査を残す。
8. **確定**（外部呼び出しとは別のトランザクション）: 依頼を `for update`。intent を `succeeded` にし、`issue_no` / `issue_url` を入れる。`request.issue_no` が空なら入れ、`version + 1`（既存と同じ）。履歴と監査を残す。依頼が `isOrderCurrent` なら job を `on conflict do nothing` で作り、古い版の job を処理する（ADR 4章）。無効なら job を作らず ERR-202。
9. 分類が `unknown` なら `sent → unknown` を commit して、時間切れは ERR-303、他は ERR-304（`details.handoffState='unknown'`）。`failed` は ERR-304。`rate_limited` は `failed` と `next_attempt_at`（`nextRetryAt`）で ERR-302。

Issue の本文は既存の本文の前に `buildHandoffMarker` の行を置き、YAML は `canonical_yaml` をそのまま使う。タイトルは `[MSF] ${id} ${title}`。

### worker の手順

`claimNextJob` の中核:

```sql
with c as (
  select id from job
   where state = any($runnable)
     and (lease_expires_at is null or lease_expires_at <= $now)
   order by created_at
   limit 1
   for update skip locked
)
update job j set lease_owner=$owner, lease_expires_at=$now + make_interval(secs => $secs),
       heartbeat_at=$now, fencing_token=j.fencing_token+1,
       session_started_at=coalesce(j.session_started_at,$now), updated_at=$now,
       lease_reclaim_count=j.lease_reclaim_count + (case when j.lease_owner is null then 0 else 1 end)
  from c where j.id=c.id returning j.*;
```

`lease_reclaim_count` は期限切れの取り直しだけを数える。**lease を外し忘れると、修正を繰り返す正常な job が `lease_lost_repeatedly` で止まる**ので、下の 4 と `releaseLease` を守る。

1. 取得したら `lease_reclaim_count > maxLeaseReclaims` → 止める（`lease_lost_repeatedly`）。`isOrderCurrent` を確かめ、無効なら止める（`order_invalidated`）。`checkTimeLimits` を確かめる。`queued` は `planning` へ動かし、そこで `signal_decided='r'` なら `stopped(red_signal_human_required)`。
2. Runner の結果を受けたら順に: `checkChangedPaths` → 違反なら `stopped(policy_violation)`。`humanApprovalTouched` → `stopped(human_approval_required)`。`status='failed'` は `implementing` なら `failed(runner_failure)`、他は `stopped(runner_failure)`。
3. 書き込みはすべて `where id=$ and fencing_token=$ and state=$expected`。rowCount 0 は `applied:false` で返し、別トランザクションで `job_event(kind='late_write_discarded')` と監査を残す。runner の結果で状態を進めない。
4. 状態を動かす更新で `pr_ready` と停止系へ入るときは lease を null にする（CHECK で必須）。`stopped` / `failed` / `cancelled` へは `stop_reason`、`remaining_work`、`stopped_at`、`resume_to`（止まる直前の状態）を同時に入れる（CHECK で必須）。人の再開ではこれらを null に戻し、`session_started_at` を null、`continuous_seconds` を 0、`lease_reclaim_count` を 0 にする（連続はそこで切れる。経過の合計は `usage` と event に残す）。修正回数と `ci_rerun_count` は戻さない。
   **lease の持ち主でない処理（人の取消・再開、`recordVerification`）が状態を動かすときは、`fencing_token` を +1 し、lease を null にする**。実行中の worker の書き込みを無効にし、次の取得を止めないため。
   止める行き先は `haltTarget(state, reason)`。`queued` に `stopped` は無いので `cancelled`。null（`pr_ready` 以降・停止系）なら状態を動かさない。
5. `verifying` は取得の対象に残す。worker は fake CI を呼ぶだけで、判定は `recordVerification` に任せる。呼び出しは再実行しても同じ結果になるよう、配信 ID を決定的にする: `delivery_id = fake:${jobId}:${headSha}:${ciRerunCount}`、`ci_run_id = fake-run:${headSha}:${ciRerunCount}`、`run_sequence = repairCountTotal * 100 + ciRerunCount + 1`。worker が途中で落ちても、次の取得で同じ配信になり `duplicate` で無視される。
6. 工程が終わったら、状態が同じでも `releaseLease` で lease を外す。`revising → verifying` で新しい `head_sha` を入れるときに `ci_rerun_count` を 0 に戻す（上限はコミットごと）。

### recordVerification の手順

1〜3 を1つのトランザクションで行う（記録だけ残って状態が動かない隙間を作らない）。

1. `insert ... on conflict do nothing`（`delivery_id` と `(job_id, ci_run_id, run_attempt)`）。重複は `status='duplicate'` で、状態を動かさない。
2. job を `for update`。その job の全 verification を読み `evaluateVerification(records, job.head_sha, acIds)`。
3. job の状態が `verifying` で、記録の `head_sha` が `job.head_sha` と一致し、`isOrderCurrent` のときだけ状態を動かす。それ以外は記録だけで `advanced=false`。動かすとき（`incomplete` で状態が同じときも）は上の 4 のとおり fencing を +1 して lease を外す。

| verdict               | 動き                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passed`              | `pr_ready`。同じトランザクションで PR 候補を作る                                                                                                                                                                                                                                                                                                                                         |
| `failed`              | `decideRepair`。許可なら回数を増やして `revising`。不可なら `stopped(same_cause_limit / repair_total_limit)`                                                                                                                                                                                                                                                                             |
| `incomplete`          | 段階の未完に加えて、AC の未確認・欠落・`not_run`、AC が 0 件の場合。`isCiRerunAllowed` なら `ci_rerun_count + 1` で `verifying` のまま。不可なら `stopped(ci_rerun_limit)`。実 CI（`source='github'`）は再実行を要求できないので、すぐ `stopped(ci_incomplete)`（再開可。AC なら `stop_detail.cause='AC 未確認'`） 実 CI で artifact が読めて AC の試験だけが足りないときは `revising`。 |
| `stale` / `no_result` | 動かさない                                                                                                                                                                                                                                                                                                                                                                               |

`evaluateVerification` の verdict の意味:

| verdict      | 意味                                                                                                                                                             | 意味しないこと                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `passed`     | head の最新の記録で、必須段階が全部 passed、かつ AC が全件 ○                                                                                                     | 受入の合格ではない。合否と merge の判断は人   |
| `failed`     | 必須段階の失敗か AC の ×（修正の対象）                                                                                                                           | `failedStages` が空なら CI は成功している     |
| `incomplete` | 段階が走り切っていない、AC に未確認がある、AC が 0 件。報告に注文書に無い AC（`unknownAcs`）、同じ AC の重複（`duplicateAcs`）、v2 の範囲（依頼の識別子・試験ファイル）を持たない実 CI の結果（`unscopedAcs`）があれば全件未確認（× も作らない） | `incompleteStages` が空なら CI は成功している |
| `stale`      | head の結果が無く、古い SHA の結果だけがある                                                                                                                     |                                               |
| `no_result`  | 結果がまだ無い                                                                                                                                                   |                                               |

言葉を分ける（画面・PR 本文・API で混ぜない）:

| 言葉              | 決まり方                                                             | API の項目                           |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------ |
| CI 成功           | 今の head の最新の記録で必須段階が全部 passed。AC の結果は混ぜない   | `evidence[jobId].ciResult='success'` |
| 受入条件 全件確認 | CI の `ac-results` v2 で AC が全件 ○。各結果の依頼の識別子と `testFile` が、この job の依頼と PR の変更ファイルに一致すること。AI の申告と PR 本文は根拠にしない | `evidence[jobId].ac.label`           |
| PR 候補の準備完了 | CI 成功かつ受入条件 全件確認で、人の確認待ち                         | `JobView.state='pr_ready'`           |
| 受入の合格        | 人の判断。システムは出さない                                         | なし                                 |

`GET /api/requests/:id/jobs` の `evidence[jobId].ac` は今の head の AC の集計（`label` は「受入条件 全件確認 / 未確認あり / 不合格あり」）で、`ciResult` は今の head の CI の成否（`success` / `failure` / `incomplete` / `stale`）。どちらも検証の記録があるときだけ載る。

投入の runner は `DEVLINE_RUNNER_KIND`（サーバの設定）だけで決まる。`docker-claude` なら job の `runner_kind='docker-claude'`、Issue は `DEVLINE_GITHUB_TOKEN`。資格情報や対象が足りなければ ERR-405 で、fake へ落とさない（`docs/devline/real-runner.md` 13 章）。

fence の無い関数だが、CI は lease の持ち主ではないので状態の条件で守る。production では `source='fake_ci'` を拒否する。

### PR 候補

`PR_DECISION_ITEMS` の10項目と `PR_AGENTS_HEADINGS` の12見出しをすべて含む Markdown。`job_artifact(kind='pr_body_draft', content=...)`。AC は `acEvidence` の ○／×／未確認。現場向けでなければ 6・7 は「対象外」。プレビュー URL など無いものは「未実施（fake PoC）」と書き、成功のように書かない。実 PR は作らない。

## 2. HTTP API

すべて既存の `auth()` / `mutate()`（CSRF）を使い、`auth.ts` は変更しない。エラーは既存の `{error:{code,message,details,correlationId}}`。

| ID     | メソッド・パス                   | 本文                                                                | 応答                                                                                                                                     | 権限                                                  |
| ------ | -------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| API-06 | `POST /api/orders/:id/handoff`   | `{ orderVersion: int≥1, confirmAbsent?: boolean, reason?: string }` | `HandoffResult`                                                                                                                          | desk / approver（confirm_absent は approver / admin） |
| 既存   | `POST /api/requests/:id/handoff` | なし                                                                | `{issueNo, issueUrl, created, detail}`                                                                                                   | desk / approver                                       |
| 新規   | `GET /api/jobs/:id`              | －                                                                  | `{ job: JobView }`                                                                                                                       | ログイン済み                                          |
| 新規   | `GET /api/requests/:id/jobs`     | －                                                                  | `{ items: JobView[], handoffs: HandoffView[], currentTargetRepo: string \| null, evidence: Record<jobId, JobEvidence> }`（版の新しい順） | ログイン済み                                          |
| 新規   | `GET /api/devline/target-repos`  | －                                                                  | `{ items: [{ name, repoId, purpose, isDefault }], defaultRepo: string \| null }`（設定と台帳の積集合。先頭が既定）                       | ログイン済み                                          |
| 新規   | `PATCH /api/requests/:id/devline-target` | `{ targetRepoId: string \| null }`                          | `{ targetRepo: { requestId, targetRepoId, defaultRepo, changed } }`                                                                      | desk / approver                                       |
| 新規   | `POST /api/jobs/:id/cancel`      | `{ reason: string, expectedState?: JobState }`                      | `{ job: JobView }`                                                                                                                       | desk / approver / admin                               |
| 新規   | `POST /api/jobs/:id/resume`      | `{ reason: string, expectedState?: JobState }`                      | `{ job: JobView }`                                                                                                                       | desk / approver / admin                               |

- API-06 の `:id` は受付番号。注文書に別の ID は無い。
- **依頼ごとの投入先（L-12）**: 依頼（`request.target_repo_id`。additive migration 0015）に `owner/name` を持つ。**作成**（`POST /api/requests`）の `targetRepoId` と、`PATCH /api/requests/:id/devline-target` の値は、**サーバが** 設定（`DEVLINE_TARGET_REPOS`）と許可台帳（`DEVLINE_REPO_LEDGER`）の**積集合**で決め直す（画面の値を信じない）。積集合の外は ERR-405。未指定（NULL）は従来どおり既定＝積集合の先頭で、既存の依頼はすべて NULL（後方互換）。
- **内容の更新（`PATCH /api/requests/:id`）では投入先を変えられない**。変化する `targetRepoId` は ERR-004（`details.field='targetRepoId'`）。同じ値の再送は受理し、列は触らない（古い画面の互換）。変更は専用の口（`PATCH /api/requests/:id/devline-target`）だけにする。これは**食い違いを作れないようにする**ため: 投入済み・結果未確定の依頼で `request.target_repo_id` だけが動くと、作り済みの Issue と job の repo（と注文書の記録）と食い違い、次の投入が ERR-405 になる。
- **認可は非対称で、これは意図**。投入前の依頼は依頼者も自分で作れる（作成の `targetRepoId` は依頼者の入力）。一方、**投入先を後から変えるのは desk / approver だけ**（専用の口）。投入済み・結果未確定の整合性を守る操作なので、依頼者や requester ロールには開けない（開けると自分の依頼で対象 repo を差し替えられる）。
- `PATCH /api/requests/:id/devline-target` は内容の編集ではないので `version` / `order_version` / 承認を動かさない（監査 `request.update` に `from` / `to` を残す）。結果未確定（`intent` / `sent` / `unknown`）の投入があるときは ERR-301、終了・保留の依頼は ERR-201、取り下げた依頼は ERR-104。承認後でも使えるので、画面の選択はこちらを使う（内容の PATCH だと承認がやり直しになる）。
- 投入済みの repo と食い違う変更は ERR-405。比較は**実効値**（次に投入する repo）で行う。未指定（`null`）は既定＝積集合の先頭に解決されるので、**`null` へ戻す変更も同じ検査を通る**（例: B へ投入済みの依頼で `null` に戻すと、次は既定の A へ行こうとするので拒否。既定が B なら `changed=false` で通る）。積集合が空で実効値が決まらないときは、投入そのものが ERR-405 になるため比較しない。
- `JobView` に `canonical_yaml`、lease の所有者名、`stop_detail` 内の秘密情報を含めない。
- `HandoffView` と `JobEvidence` は画面の表示用（読み取りのみ）。再読込の後も Issue の URL と結果不明を表示するために足した。`marker` と `last_error` は出さない。`issueSource` はサーバが `GITHUB_API_URL` と URL の host で決める（`api.github.com` と `github.com` のときだけ `github`）。
- `HandoffView.targetRepo` はその投入の連携先、応答の `currentTargetRepo` は今の投入先（設定から決まらなければ null）。どちらも読み取りのみ。別のリポジトリに結果不明の投入があると API-06 は ERR-405（`details: { handoffState: 'unknown', targetRepo }`）で拒否するので、画面は「照合する」を出さず、対象と理由と次の手順を出す。`currentTargetRepo` が null なら別のリポジトリと決めつけない。
- API-06 の応答に `status` / `version` は無い。画面は応答の後に `GET /api/requests/:id` で取り直す（確定で `request.version` が上がるため）。

### 新旧の handoff の契約

どちらも同じ処理（版固定、`handoff_intent`、job の作成）を通る。正は API-06 で、旧ルートは互換のために残す。

| 項目             | API-06 `POST /api/orders/:id/handoff`                                                                                        | 旧 `POST /api/requests/:id/handoff`                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `:id`            | 受付番号（`REQ-YYYY-NNNN`）。注文書は独立の ID を持たない（SC-09 の案）                                                      | 受付番号                                                    |
| 版               | 本文の `orderVersion`。古い版は ERR-202                                                                                      | 指定なし。いまの版を使う                                    |
| 投入先           | 依頼の `target_repo_id`（積集合で検証済み）。未指定は `DEVLINE_TARGET_REPOS` の先頭                           | 同じ                                                        |
| 冪等             | 受付番号＋版＋対象 repo。同じ版の再投入は `created=false`                                                                    | 同じ。`issue_no` 済みなら新しい処理を呼ばず `created=false` |
| 応答             | `HandoffResult`（`requestId`、`orderVersion`、`issueNo`、`issueUrl`、`jobId`、`jobState`、`contentSha256`、`created`、`op`） | `{ issueNo, issueUrl, created, detail }`                    |
| 結果不明         | ERR-304 と `details.handoffState`。作り直さず list API で照合する。`confirmAbsent` は走査が完全なときだけ                    | 同じ ERR-304                                                |
| 版が上がったとき | 同じ Issue を更新し、古い job は `queued` なら取消、実行中なら `stopped(order_superseded)`（ADR 4 章）                       | 同じ                                                        |
| 権限             | desk / approver                                                                                                              | desk / approver                                             |

旧ルートの変更点は ADR 7 章。

- API-07（`POST /api/jobs/:id/verifications`）は作らない。ルートが存在しないことを試験する。
- zod は 3 / 4 両対応の書き方に限る: `z.record` は2引数、`error.issues`（`.errors` は使わない）、`z.string().uuid()` は可、`.merge` と `z.nativeEnum` は避ける（`z.enum(JOB_STATES)` を使う）。schema は `src/api/schemas.ts`。`src/shared/devline.ts` に zod を入れない。

### 人の承認 → merge → 検証環境への配備 → 戻し（仕様 4-9、FR-39〜41、TC-N09）

実装は `src/api/devline-release.ts`、判定の純関数は `src/shared/devline-release.ts`、worker は `src/worker/deploy-*.ts`。すべて `mutate()`（CSRF）を通す。本文は strict で、repo、runner 種別、予算、イメージ名、ポートは受けない。

| API                                  | 本文                                                                  | 動き                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/jobs/:id/approve-merge`   | `{ headSha, reconcileOnly? }`（40桁。`reconcileOnly` は `true` だけ） | サーバが検査して、`sha` を渡して squash で merge する。結果不明と落ちた送信中は読むだけの照合で、merge を送らず承認も残さない。merge 済みなら記録する。未 merge なら `merge_state='none'`、ERR-202（409、`details: { mergeState: 'none', detail: 'not_merged' }`）。`reconcileOnly` は照合のボタンで、結果不明でなければ ERR-301（`not_unknown`）で送らない。merge 済みなら同じ結果 |
| `POST /api/jobs/:id/revoke-approval` | `{ headSha, reason }`（必須）                                         | merge の承認を取り消す（行を追記）。送信中、merge 済み、効いている承認が無いときは拒否。結果不明の merge は照合で確かめる                                                                                                                                                                                                                                                           |
| `POST /api/jobs/:id/approve-deploy`  | `{ sha, digest, environment }`                                        | 3つが記録と一致するときだけ、配備の試行を積む。worker が digest をそのまま起動する                                                                                                                                                                                                                                                                                                  |
| `POST /api/jobs/:id/rollback`        | `{ reason }`（必須）                                                  | この job の版が環境に載っていて前の版があるときだけ、戻しの試行を積む                                                                                                                                                                                                                                                                                                               |
| `GET /api/requests/:id/jobs`         | －                                                                    | `release`（job ID ごと）を足す。PR、merge、AC、承認（申請した人、判定、`status`：有効・使用済み・失効の理由）、成果物と取得元、配備、戻し。トークンと内部エラーの本文は返さない                                                                                                                                                                                                     |
| `GET /api/devline/summary`           | －                                                                    | `{ stopped, mergeWaiting }`。DevOps の KPI（W-09）                                                                                                                                                                                                                                                                                                                                  |

**状態**: job は merge が確定するまで `pr_ready` に置く。遷移表に `approved` から戻る辺が無く、失敗すると行き止まりになるため。確定したら同じトランザクションで `pr_ready → approved → merged`（event を1行ずつ）。配備の成功で `merged → staged`。配備の失敗は `merged` のまま、戻しの後は `staged` のまま。途中経過は `release.merge_state`（`none/sending/unknown/rejected/merged`）。

**失効の規則**（`decideMerge`、`decideDeploy`、`decideRollback`）:

| 操作             | 拒否する場合                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| merge の承認     | 役割が approver 以外、`is_agent`、状態が `pr_ready` 以外、`headSha` が `job.head_sha` と違う、superseded、版が無効（赤信号を含む）、検査が合格でない、AC の未確認、PR の記録なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| merge の送信     | PR が閉じている、head が変わった、作成者かマーカーが違う、merge 先が既定のブランチでない、GitHub の 409（失効）。head が base の最新を含まない（compare の `behind_by > 0`。`base_behind`。失効させず、更新の後で押し直せる）、compare を読めない（`pr_unreadable`）。405 と 403 は失効させず押し直せる。送信の直前に DB を読み直し、版の更新（`approval_expired`）、検査の変化や根拠の run の変更（`verification_changed`）、取消（`approval_revoked`）なら送らない。結果不明の照合は条件を問わず読むだけ。404、読めない、許可の設定は `unknown` のまま残す（実際には merge 済みかもしれない）。閉じていて未 merge は `pr_closed`、開いていて head が違えば `head_changed`                                                                                                                                                       |
| 承認の取消       | 人の条件、状態が `pr_ready` 以外、送信中（新しい印）、効いている承認が無い、`headSha` が違う                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 配備の承認       | 上の人の条件、状態が `merged` 以外、superseded、版が無効、tree の不一致か未確認、SHA・digest・環境の不一致、成果物が未検査                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 配備（worker）   | 承認の後で版が上がった、記録が変わった（`approval_expired`）。イメージが無い、名前が別のコンテナに使われている。配備先に触っていなければ、環境の版と URL は変わらない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 成果物（worker） | tree の不一致か未確認（`not_buildable`）。合否の根拠の run に artifact が無い（`artifact_missing`）、期限切れ（`artifact_expired`）、上限超え（`artifact_too_large`）、repo・run・試行・head・tar のハッシュ・タグ・イメージ ID の不一致（`artifact_mismatch`）、通信の失敗（`artifact_unavailable`）、読み込みの失敗（`artifact_load_failed`）。どれもこのホストで作り直さず、配備の承認へ進めない。tree が一致していて digest が決まる前の失敗は、種類を問わず承認者が `approve-merge` を押し直すと同じ run の成果物を取り直す（merge は送らない。検査は毎回すべて行う。監査は `job.artifact_retry`）。tree の不一致は押し直しても取り直さない。tree が未確認のときは、押し直すと tree を読み直し、一致したときだけ取得へ進む（この経路では押し直した人の監査が残らない。取得の結果は worker が `job.build_result` に記録する） |
| 戻し             | 人の条件、状態が `staged` 以外、別の版が載っている、戻す先が無い、理由が空                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

merge の口（`createGithubPrMergeAdapter`）を作るのは `devline-release.ts` だけで、worker と runner は import しない（`tests/unit/devline-release.test.ts` で固定）。自動マージ（`DEVLINE_AUTO_MERGE=1`）は `devline-auto-merge.ts` が `defaultReleaseDeps()` の merge の口を受け取って実行し、契機だけを worker が持つ（`docs/devline/real-runner.md` 17章）。AI のコンテナからはどちらにも到達できない。

## 3. エラーコード

**新しい番号は作らない。** すべて既存の意味の範囲に収まる。

| 場面                                                   | コード  | HTTP     | 既存の意味との関係                                      |
| ------------------------------------------------------ | ------- | -------- | ------------------------------------------------------- |
| 未承認・差戻し・取消・承認記録なし／不一致             | ERR-205 | 409      | 承認されていない注文書は投入できない                    |
| 本文の版が最新でない、確定時に依頼が無効になった       | ERR-202 | 409      | 承認後に内容が変わった                                  |
| 別の処理が進行中、`expectedState` の不一致             | ERR-301 | 409      | ほかの人が先に更新した                                  |
| 応答不明で見つからない、接続できない、確定した 4xx     | ERR-304 | 502      | 連携先に接続できなかった。`details.handoffState` で区別 |
| 時間切れ（API-06）                                     | ERR-303 | 504      | 時間切れ。旧ルートでは ERR-304 に揃える                 |
| 混雑、`next_attempt_at` より前                         | ERR-302 | 429      | 混み合っている                                          |
| 権限なし                                               | ERR-101 | 403      | 拒否は監査に残す                                        |
| 依頼・job が無い                                       | ERR-104 | 404      |                                                         |
| 理由が空（cancel / resume / confirm_absent）           | ERR-102 | 400      |                                                         |
| 取り消せない状態、再開できない理由                     | ERR-201 | 409      | その状態へは変更できない                                |
| 再開時に注文書が無効                                   | ERR-202 | 409      |                                                         |
| 取込（全置換）と devline の行の衝突                    | ERR-201 | 409      | 理由を表示                                              |
| GitHub 未設定、対象リポジトリが許可外、未実装の runner | ERR-405 | 既存 409 | システムの設定が合っていない（仕様は 500。ADR U-15）    |
| 依頼の `targetRepoId` が積集合の外、別の repo に投入済み | ERR-405 | 既存 409 | 対象リポジトリが許可外（新しいコードは作らない）          |
| 内容の更新で投入先を変えようとした                       | ERR-004 | 400      | 選べない値。変更は専用の口だけ（食い違いを作れない）      |
| 依頼の投入先の変更で、結果未確定の投入がある             | ERR-301 | 409      | ほかの人が先に更新した。先に照合する                      |

`details` に token、接続文字列、外部応答の全文を入れない。外部応答は `last_error` に 500 文字まで、秘密を含みうる header は保存しない。

**監査の action**: `order.snapshot` `handoff.intent` `handoff.sent` `handoff.succeeded` `handoff.unknown` `handoff.failed` `handoff.confirm_absent` `job.create` `job.transition` `job.cancel` `job.resume` `job.late_write_discarded` `verification.record` `job.auto_merge` `job.merged`。`role` と `actor_name` は人なら既存どおり、worker は `system`、runner の結果は `agent` / `agent:fake`、自動マージは `role='system'`・`actor_name='system:auto-merge'`。`actor_user_id` は null。

自動マージ（0014）は `docs/devline/real-runner.md` 17章。既定は無効（`DEVLINE_AUTO_MERGE=0`）で、有効なときだけ条件をすべて満たす job をサーバが squash merge する。人の承認の行（`release_approval`）は作らず、`release.auto_merge*` の列と `audit_log` に根拠（ポリシー版・verdict・AC・head・run）を残す。API の形（`approve-merge` ほか）は変えない。

## 4. Dev が守ること

1. **DB の URL**: `db.ts verify` は `DATABASE_URL`、`migrate` は `MIGRATION_DATABASE_URL` を先に見る。設定のコピーでは DB の URL 4つすべてを自分の `_test` に向ける。
2. **実 GitHub へ送らない**: 設定のコピーから `GITHUB_TOKEN` を外す。adapter は `NODE_ENV=test` で `GITHUB_API_URL` がループバック以外なら拒否する。
3. **`src/worker` を `tsconfig.api.json` の `include` に足す**（足さないと typecheck も build も通らないまま素通りする）。`tsconfig.json` にも同様に。`package.json` に `worker` を追加。
4. worker は `DEVLINE_WORKER_ENABLED=1` のときだけ起動。`NODE_ENV=production` では fake を起動しない。`IMPLEMENTED_RUNNER_KINDS` 以外は起動時に拒否。
5. `resetDemo` と `importAll` を ADR 5章のとおり直す。忘れると ERR-401 になる。
6. `node-pg` は int8 と numeric を Number にする（`db.ts`）。`date` 列を `toISOString` で切らない（既存の不具合。今回 YAML の修正はしない）。
7. 版固定は一度だけ。依頼から YAML を再生成して比べない。
8. `src/shared` に `node:crypto` と zod を入れない。import は `.js` 付きの相対パス。
9. `.github/workflows/` を変更しない。push しない。
10. 監査の `appendAuditTx` は advisory lock を取るので、長いトランザクションや外部呼び出しの中で呼ばない。
11. 試験の依頼は `performTransition` で承認して作る。見本データの承認には `approver_user_id` が無く、ERR-205 になる。

## 5. QA の試験項目

実行は専用の `_test` DB。時刻は引数で与え、sleep しない。外部は OS 割当ポート（`0`）のローカル fake サーバ。**未実装・skip を合格にしない。**

### 契約と DB

| ID   | 内容                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------ |
| T-01 | `0008` が空 DB に当たり、生 SQL の再適用（2回）でも失敗しない                                    |
| T-02 | TS と SQL の遷移表が全組合せで一致（job 15×15、handoff 5×5）。`STOP_REASONS` と CHECK も一致     |
| T-03 | job の遷移表が仕様 4-3 の表と一致（期待値を試験に直書き。実行中 → `cancelled` が無いこと）       |
| T-04 | `order_snapshot` `job_event` `job_artifact` `verification` の UPDATE / DELETE が拒否される       |
| T-05 | `job` `handoff_intent` `job_attempt` の DELETE が拒否され、終わった attempt は UPDATE できない   |
| T-06 | job は `queued` 以外で作れない。不正な遷移・識別列の変更・fencing の減少が DB で拒否される       |
| T-07 | 停止系は理由・残作業・時刻・再開先が無いと拒否。lease を持ったまま `pr_ready` / 停止系へ行けない |
| T-08 | `truncate ... cascade`（`truncateBusiness` と `db.ts reset`）が devline の行があっても通る       |
| T-09 | `db.ts verify` が成功し、監査のハッシュ連鎖が devline の操作の後も OK                            |

### 版固定

| ID   | 内容                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------ |
| T-10 | 同じ入力から2回生成して同じハッシュ（TZ を変えても同じ）                                               |
| T-11 | `status` を dev に変えても、`buildSnapshotYaml` の結果が同じ。`buildOrderYaml` の形式の既存試験が通る  |
| T-12 | 版固定の後に部署名・道具の色を変えても、保存した本文とハッシュが変わらず、再投入で同じ結果を返す       |
| T-13 | NFD の入力と NFC の入力で同じハッシュ。単独 CR が残らない。DB の hash CHECK が通る                     |
| T-14 | ADR 3章の固定値と一致                                                                                  |
| T-15 | 未承認、差戻し、見送り、取消、削除、旧版、承認記録なし、`approver_user_id` なしを拒否（ERR-205 / 202） |
| T-16 | 承認 → 編集 → 再承認で版が2上がり、古い版の投入が ERR-202                                              |
| T-17 | DB のトリガ単独でも旧版・別の承認者を拒否する                                                          |
| T-18 | 注文書の本文に `<!-- msf-handoff:…` やマーカーと同じ文字列があっても、照合で一致しない                 |

### 冪等 handoff

| ID   | 内容                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-20 | 通常の投入で Issue 1つ、intent `succeeded`、`request.issue_no`、job `queued`、本文1行目がマーカー                                                                                     |
| T-21 | 同じ版の再投入で Issue が増えず `created=false`。同じ `jobId`                                                                                                                         |
| T-22 | 並行2投入で Issue は1つ。負けた側は ERR-301 か既存の結果                                                                                                                              |
| T-23 | 外部呼び出しの直前に順序が守られる（fake サーバの受信時点で intent が `sent` で commit 済み）                                                                                         |
| T-24 | 応答喪失（作成後に切断）: `unknown`、ERR-304。再投入で照合して回収し Issue は1つ、`created=false`                                                                                     |
| T-25 | 確定の前に落ちた: `sent` のまま。`sentStaleMs` 前は ERR-301、後は照合で回収                                                                                                           |
| T-26 | 時間切れは API-06 で ERR-303、旧ルートで ERR-304。5xx と 2xx の壊れた本文は `unknown`                                                                                                 |
| T-27 | 4xx は `failed`、再投入で再送できる                                                                                                                                                   |
| T-28 | 429 と、Retry-After 付きか `x-ratelimit-remaining: 0` の 403 は `failed` と `next_attempt_at`（既定の待ちと Retry-After の遅い方）。その前の再投入は ERR-302 で fake サーバに届かない |
| T-29 | 見つからない `unknown`: `confirm_absent` なしでは再送せず `unknown` のまま                                                                                                            |
| T-30 | `confirm_absent`: 理由なしは ERR-102、desk は ERR-101、approver で再作成。監査が残る                                                                                                  |
| T-31 | 照合がページ送りで2ページ目の Issue を見つける。closed の Issue も見つける。PR は除外                                                                                                 |
| T-32 | 照合が `reconcileMaxPages` で切れたら `confirm_absent` があっても再送しない                                                                                                           |
| T-33 | 他人が作った同じマーカーの Issue を一致させない                                                                                                                                       |
| T-34 | search API を呼ばない（fake サーバのアクセス記録で確認）                                                                                                                              |
| T-35 | 再承認した版の投入は同じ Issue を PATCH。Issue は増えない。`request.issue_no` は同じで、intent は版ごと                                                                               |
| T-36 | v1 create が `unknown` のあいだ v2 は作成しない。照合で回収すると v2 は `update_issue`                                                                                                |
| T-37 | v2 の後に v1 を指定した投入は、intent が `failed` / `intent` でも ERR-202 で外部へ送らず、v2 の本文が上書きされない                                                                   |
| T-38 | 確定の前に依頼が取り消された: intent は `succeeded`、`request.issue_no` は入る、job は作らず ERR-202                                                                                  |
| T-39 | 再承認で古い job が `cancelled` / `stopped(order_superseded)` / `superseded_at` になる                                                                                                |
| T-40 | 旧ルートの応答の形・`issue_no` 済みの動き・ERR-405 / ERR-304・権限が ADR 7章のとおり。狭まる2点が ERR-205                                                                             |
| T-41 | 対象リポジトリが許可リストの外なら ERR-405 で fake サーバに届かない。本文で repo を指定できない                                                                                       |
| T-42 | 同じ版の `failed` の intent があるまま依頼が差戻し・取消になった後、再投入は ERR-205 で外部へ送らない。`unknown` の照合（読み取り）だけは行い、見つかれば記録する                     |

### job と lease

| ID   | 内容                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-50 | 並行の `claimNextJob` で同じ job を2人が取らない（`skip locked`）                                                                                           |
| T-51 | 期限切れの lease を別の worker が取り直すと fencing が増え、古い worker の書き込みは `applied:false` で event が残る                                        |
| T-52 | `now` を引数で進めるだけで期限切れと上限が試せる（sleep なし）                                                                                              |
| T-53 | `lease_reclaim_count` が上限を超えると止まる。一方、修正を5回繰り返す正常な job は `lease_lost_repeatedly` にならず `repair_total_limit` まで進む           |
| T-54 | `queued` の取消で `cancelled`、実行中で `stopped(cancel_requested)`、`pr_ready` で ERR-201、再度の取消は変化なし                                            |
| T-55 | 取消の後に届いた runner の結果と heartbeat が捨てられ、状態が動かず event が残る                                                                            |
| T-56 | 再開は `resume_to` へ戻り、fencing が増える。worker からは再開できない                                                                                      |
| T-57 | 回数切れ・policy 違反・版の失効の停止は再開できない（ERR-201）。注文書が無効なら ERR-202                                                                    |
| T-58 | 依頼の編集・差戻し・取消の後、次の工程で `stopped(order_invalidated)`（`queued` なら `cancelled(order_invalidated)`）。`pr_ready` では `orderCurrent=false` |
| T-59 | worker が `request.status` と `request.version` を変えない（確定の `issue_no` 以外）                                                                        |
| T-60 | `isPhase1Transition` により `pr_ready` から先へ進まない。縦断の後で `reviewing` 以降の event が無い                                                         |

### Runner と policy

| ID   | 内容                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-61 | fake の `capability.isolation` が `none`。`local-isolated` / `real` は ERR-405 で拒否、実行しない                                                              |
| T-62 | `success`: 縦断で `pr_ready`。artifact の sha256 が実物と一致                                                                                                  |
| T-63 | `test_fail_then_fix`: `revising` を経て `pr_ready`、`repair_count_total=1`                                                                                     |
| T-64 | `same_cause_fail`: 同因2回の修正の後 `stopped(same_cause_limit)`。別原因で合計5回なら `repair_total_limit`                                                     |
| T-65 | `hang`: `now` を進めて `stopped(session_limit)`、`cancel` が呼ばれる。連続2時間で `continuous_limit`                                                           |
| T-66 | `forbidden_path`: `.github/workflows/**`、secret 類、`src/api/auth.ts`、配備定義、大小文字違い、`./`・`..`・`\` の表記揺れすべてで `stopped(policy_violation)` |
| T-67 | `injection`: 本文の命令で policy・シナリオ・snapshot が変わらない                                                                                              |
| T-68 | 費用が0円で計上され、`usage` の形が残る。fake の子プロセスや任意 shell を起動しない                                                                            |
| T-69 | `NODE_ENV=production` で fake を起動しない。`DEVLINE_WORKER_ENABLED` 未設定で worker が動かない。HTTP 要求の中で実行しない                                     |
| T-70 | 赤信号の依頼が計画の前に `stopped(red_signal_human_required)`                                                                                                  |

### 検証証跡

| ID   | 内容                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------- |
| T-71 | 全段階 passed の最新 run で `pr_ready`                                                                   |
| T-72 | missing / skipped / cancelled は不合格（`incomplete`）で修正回数を使わない。再実行2回で `ci_rerun_limit` |
| T-73 | 別 SHA の結果は記録されるが `pr_ready` にならない（`stale`）                                             |
| T-74 | `delivery_id` の重複は無視。内容が違っても上書きしない                                                   |
| T-94 | worker が `verifying` で落ちて取り直しても、配信 ID が同じなので検証結果は1件で、修正回数も増えない      |
| T-75 | 古い run の成功が後から届いても、新しい失敗を上書きしない（到着順と `run_sequence` を逆にする）          |
| T-76 | 段階を複数の run から寄せ集めて合格にしない                                                              |
| T-77 | Runner の `status='succeeded'` だけでは `pr_ready` にならない（CI の結果が無ければ `verifying` のまま）  |
| T-78 | 取消・停止の後の結果は記録されるが状態が動かない                                                         |
| T-79 | AC → test ID → run → SHA → digest をたどれる。test ID の無い passed は「未確認」、failed の AC は不合格  |
| T-80 | production で `source='fake_ci'` を拒否。`agent` は DB で拒否。API-07 のルートが 404                     |

### 権限と PR 候補

| ID   | 内容                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| T-85 | cancel / resume は desk / approver / admin のみ。requester は ERR-101 で監査に `denied`。admin の判定は `isAdmin` |
| T-86 | 未ログインの GET は ERR-106。mutate の CSRF が効く。`JobView` に `canonical_yaml` と lease の所有者名が無い       |
| T-87 | 監査に `system` と `agent` が残り、ハッシュ連鎖が OK                                                              |
| T-88 | PR 候補に10項目と12見出しが全部あり、AC 別に ○／×／未確認。実 PR の API を呼ばない                                |
| T-89 | PR 候補・応答・ログ・event に token、接続文字列、個人メールが出ない                                               |

### 回帰と破壊防止

| ID   | 内容                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------- |
| T-90 | devline の行があるとき `resetDemo` が成功する（非本番）。`importAll` は ERR-201 で既存データが残る |
| T-91 | `approval` と `request` の列定義が `0008` の前後で同じ                                             |
| T-92 | 既存の `pnpm test` がすべて通る                                                                    |
| T-93 | 同じ `POST` の再実行で監査・履歴が二重に増えない（再投入は成功済みなら履歴を足さない）             |
