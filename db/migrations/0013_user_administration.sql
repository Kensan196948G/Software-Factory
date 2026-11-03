-- 0013_user_administration.sql — 職務分離のための利用者管理（複数ユーザー・承認者マスタ）
--
-- additive のみ。既存の行・列は変えない。0012 まで適用済みの DB にそのまま足せる。
-- 破壊的な変更（列の削除・型変更・既存行の書き換え）はしない。
--
-- ・無効化の日時と実行者は監査の補助として持つ（正本は audit_log）。
-- ・ロールの付与日時・付与者も同じく補助。
-- ・表示名・メールから承認者（approver ロールの利用者）を引くための索引を足す。

alter table app_user add column if not exists deactivated_at timestamptz;
alter table app_user add column if not exists deactivated_by uuid references app_user (id) on delete set null;
alter table app_user add column if not exists password_changed_at timestamptz;

comment on column app_user.deactivated_at is '無効化した日時（正本は audit_log。画面と運用の補助）';
comment on column app_user.deactivated_by is '無効化した利用者（正本は audit_log）';
comment on column app_user.password_changed_at is 'パスワードを最後に変えた日時（本数・値は持たない）';

-- 承認者マスタの解決（表示名・メール → 利用者ID）を引くための索引。
-- 表示名は一意ではないため、作成の古い順で1件に決める（service 側の並びと合わせる）。
create index if not exists app_user_display_name_idx on app_user (display_name, created_at);
create index if not exists app_user_active_idx on app_user (is_active) where is_active;

alter table user_role add column if not exists granted_at timestamptz not null default now();
alter table user_role add column if not exists granted_by uuid references app_user (id) on delete set null;

comment on column user_role.granted_at is 'ロールを付与した日時（既存行はこのmigrationの適用時刻）';
comment on column user_role.granted_by is 'ロールを付与した利用者';
