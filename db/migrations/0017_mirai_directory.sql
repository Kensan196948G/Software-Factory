-- 0017_mirai_directory.sql — Mirai-Info（社員名簿・組織）に部署と社員名を合わせる
--
-- additive のみ。既存の行・列は消さない。
--
-- ・部署は「選べる部署」と「過去の部署」を分ける（selectable）。
--   Mirai-Info の division に合わせた 16 部署を selectable=true で足し、
--   これまでの機能別 19 部署は selectable=false にして履歴の参照用に残す。
-- ・道具カタログは部署と道具の対応（department_tool）で持つ。
--   同じ道具を複数の部署（例：各支店の「入札情報」）に出すため、道具の行は増やさない。
-- ・社員名は Mirai-Info の社員名簿（有効のみ）から取り込む。
--   個人情報を最小にするため、持つのは氏名・ヨミ・部署・課だけ（メール・連絡先は持たない）。

alter table department add column if not exists selectable boolean not null default true;
alter table department add column if not exists source text not null default 'seed';

comment on column department.selectable is '画面の選択肢・カタログに出すか（Mirai-Info の部署は true、旧機能別部署は false）';
comment on column department.source is '部署の出どころ（seed / mirai_info）';

create table if not exists department_tool (
  dept_code text not null references department(code) on delete cascade,
  tool_id text not null references catalog_tool(id) on delete cascade,
  sort_order integer not null,
  primary key (dept_code, tool_id)
);

comment on table department_tool is '部署に出す道具（同じ道具を複数の部署に出すための対応表）';

create table if not exists mirai_employee (
  employee_no text primary key,
  name text not null,
  name_kana text,
  division_code text references department(code) on delete set null,
  section text,
  is_active boolean not null default true,
  synced_at timestamptz not null default now()
);

create index if not exists mirai_employee_division_idx on mirai_employee (division_code, name) where is_active;

comment on table mirai_employee is 'Mirai-Info の社員名簿（有効のみ）。PII は氏名・ヨミ・部署・課に限定する';
