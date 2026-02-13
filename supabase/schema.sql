-- Run in Supabase SQL editor
-- 1) Main recipes table
create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  short_description text null,
  description text null,
  instructions text null,
  ingredients jsonb not null default '[]'::jsonb,
  categories text[] not null default '{}',
  tags text[] not null default '{}',
  servings integer not null default 2,
  image text null,
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists recipes_owner_id_idx on public.recipes(owner_id);
create index if not exists recipes_visibility_idx on public.recipes(visibility);
create index if not exists recipes_updated_at_idx on public.recipes(updated_at desc);
create index if not exists recipes_tags_idx on public.recipes using gin(tags);

-- Backward-compatible migration for existing projects
alter table public.recipes add column if not exists tags text[] not null default '{}';
update public.recipes
set tags = categories
where (tags is null or cardinality(tags) = 0)
  and categories is not null
  and cardinality(categories) > 0;

-- 2) Private notes table (owner-only access)
create table if not exists public.recipe_notes (
  recipe_id uuid primary key references public.recipes(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  notes text null,
  updated_at timestamptz not null default now()
);

create index if not exists recipe_notes_owner_id_idx on public.recipe_notes(owner_id);

-- 3) Weekly menus table
create table if not exists public.weekly_menus (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  meal_data jsonb not null default '{}'::jsonb,
  cell_people_count jsonb not null default '{}'::jsonb,
  cooked_status jsonb not null default '{}'::jsonb,
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, week_start)
);

create index if not exists weekly_menus_owner_id_idx on public.weekly_menus(owner_id);
create index if not exists weekly_menus_visibility_idx on public.weekly_menus(visibility);
create index if not exists weekly_menus_week_start_idx on public.weekly_menus(week_start);

-- 3) Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists recipes_set_updated_at on public.recipes;
create trigger recipes_set_updated_at
before update on public.recipes
for each row execute function public.set_updated_at();

drop trigger if exists recipe_notes_set_updated_at on public.recipe_notes;
create trigger recipe_notes_set_updated_at
before update on public.recipe_notes
for each row execute function public.set_updated_at();

drop trigger if exists weekly_menus_set_updated_at on public.weekly_menus;
create trigger weekly_menus_set_updated_at
before update on public.weekly_menus
for each row execute function public.set_updated_at();

-- 4) RLS
alter table public.recipes enable row level security;
alter table public.recipe_notes enable row level security;
alter table public.weekly_menus enable row level security;

-- recipes policies
drop policy if exists "recipes_select_own_or_public" on public.recipes;
create policy "recipes_select_own_or_public"
on public.recipes
for select
using (owner_id = auth.uid() or visibility = 'public');

drop policy if exists "recipes_insert_own" on public.recipes;
create policy "recipes_insert_own"
on public.recipes
for insert
with check (owner_id = auth.uid());

drop policy if exists "recipes_update_own" on public.recipes;
create policy "recipes_update_own"
on public.recipes
for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "recipes_delete_own" on public.recipes;
create policy "recipes_delete_own"
on public.recipes
for delete
using (owner_id = auth.uid());

-- recipe_notes policies (owner-only)
drop policy if exists "recipe_notes_select_own" on public.recipe_notes;
create policy "recipe_notes_select_own"
on public.recipe_notes
for select
using (owner_id = auth.uid());

drop policy if exists "recipe_notes_insert_own" on public.recipe_notes;
create policy "recipe_notes_insert_own"
on public.recipe_notes
for insert
with check (owner_id = auth.uid());

drop policy if exists "recipe_notes_update_own" on public.recipe_notes;
create policy "recipe_notes_update_own"
on public.recipe_notes
for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "recipe_notes_delete_own" on public.recipe_notes;
create policy "recipe_notes_delete_own"
on public.recipe_notes
for delete
using (owner_id = auth.uid());

-- weekly_menus policies
drop policy if exists "weekly_menus_select_own_or_public" on public.weekly_menus;
create policy "weekly_menus_select_own_or_public"
on public.weekly_menus
for select
using (owner_id = auth.uid() or visibility = 'public');

drop policy if exists "weekly_menus_insert_own" on public.weekly_menus;
create policy "weekly_menus_insert_own"
on public.weekly_menus
for insert
with check (owner_id = auth.uid());

drop policy if exists "weekly_menus_update_own" on public.weekly_menus;
create policy "weekly_menus_update_own"
on public.weekly_menus
for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "weekly_menus_delete_own" on public.weekly_menus;
create policy "weekly_menus_delete_own"
on public.weekly_menus
for delete
using (owner_id = auth.uid());
