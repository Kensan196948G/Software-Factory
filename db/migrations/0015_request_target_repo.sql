-- 0015_request_target_repo.sql — 依頼ごとの投入先リポジトリ（L-12 の解消）
--
-- additive のみ。列を1つ足すだけで、既存の行・列・制約は変えない。0014 まで適用済みの DB にそのまま足せる。
-- 破壊的な変更（列の削除・型変更・既存行の書き換え）はしない。再適用しても同じ結果になる。
--
-- 変更の理由:
-- - これまで新規投入の宛先は DEVLINE_TARGET_REPOS の先頭だけで、依頼ごとに選ぶ UI/API が無かった（docs/limitations.md L-12）。
-- - 依頼（request）に投入先を持たせ、作成・更新の API が許可台帳（DEVLINE_REPO_LEDGER）と
--   DEVLINE_TARGET_REPOS の積集合に載っている repoId だけを保存する。
-- - NULL は「未指定」で、投入のときに従来どおり既定（DEVLINE_TARGET_REPOS の先頭）を使う。
--   既存の依頼はすべて NULL のままなので、後方互換（従来の動き）が保たれる。
--
-- 形式の CHECK は order_snapshot / handoff_intent / job の target_repo_id と同じ（owner/name）。
-- 値の正しさ（積集合に載っているか）はサーバが決める。この列は「依頼が選んだ値」を持つだけで、
-- 正本は API の検証と許可台帳・設定の側にある。

alter table request add column if not exists target_repo_id text;

alter table request drop constraint if exists request_target_repo_id_format;
alter table request
  add constraint request_target_repo_id_format
  check (target_repo_id is null or target_repo_id ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$');

comment on column request.target_repo_id is
  '依頼ごとの開発ラインの投入先（owner/name）。NULL は未指定で、投入時に既定（DEVLINE_TARGET_REPOS の先頭）を使う。許可の正本は DEVLINE_REPO_LEDGER と DEVLINE_TARGET_REPOS の積集合（L-12）';

-- 依頼ごとの投入先で引くことは無い（受付番号で1件を引く）ので索引は足さない。
