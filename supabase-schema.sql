-- =========================================================
-- ملاحظاتي — مخطط Supabase الكامل (جداول + حماية RLS)
-- ---------------------------------------------------------
-- الطريقة: لوحة تحكم Supabase ← SQL Editor ← New query
--          ← الصق محتوى هذا الملف كاملاً ← Run
-- =========================================================

-- 1) جدول الملاحظات (كل صف مرتبط بصاحبه في auth.users)
create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  title       text not null default '',
  body        text not null default '',
  color       text not null default 'plain'
              check (color in ('plain','amber','rose','violet','emerald','sky','slate')),
  pinned      boolean not null default false,
  favorite    boolean not null default false,
  deleted_at  timestamptz,                       -- حذف ناعم (سلة المحذوفات)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 2) فهارس لسرعة استعلامات داخل حساب واحد
create index if not exists notes_user_id_idx      on public.notes (user_id);
create index if not exists notes_user_updated_idx on public.notes (user_id, updated_at desc);
create index if not exists notes_user_trashed_idx on public.notes (user_id, deleted_at);

-- 3) تحديث updated_at تلقائيًا عند أي تعديل
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists notes_touch_updated_at on public.notes;
create trigger notes_touch_updated_at
  before update on public.notes
  for each row
  execute function public.set_updated_at();

-- 4) منع نقل ملكية الملاحظة إلى مستخدم آخر
create or replace function public.block_user_id_change()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'user_id cannot be changed';
  end if;
  return new;
end;
$$;

drop trigger if exists notes_block_user_change on public.notes;
create trigger notes_block_user_change
  before update of user_id on public.notes
  for each row
  execute function public.block_user_id_change();

-- 5) تفعيل Row Level Security
alter table public.notes enable row level security;

-- 6) سياسة الحماية: كل مستخدم (قراءة/إضافة/تعديل/حذف) صفوفه فقط
drop policy if exists owner_only on public.notes;
create policy owner_only
  on public.notes
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 7) صلاحيات الوصول لقاعدة الـ API (مهم في المشاريع الجديدة)
--    المصادقة: الدور authenticated فقط — والـ anon لا يملك أي صفًا (auth.uid() = null)
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.notes to authenticated;
revoke all on public.notes from anon;

-- =========================================================
-- 8) إعدادات يدوبة من لوحة التحكم (ليست SQL):
--    Authentication → Providers → Email: مفعّل، و"Confirm email" = ON
--    Authentication → URL Configuration:
--       Site URL        : http://127.0.0.1:8765   (للتجربة المحلية)
--       Redirect URLs   : أضف رابط النشر مثل
--                         https://USERNAME.github.io/REPO_NAME/
--                         (وإلا لن يعمل رابط تأكيد البريد على GitHub Pages)
-- =========================================================
