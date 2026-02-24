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
  visibility text not null default 'private' check (visibility in ('private', 'public', 'link', 'invited')),
  share_token text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists recipes_owner_id_idx on public.recipes(owner_id);
create index if not exists recipes_visibility_idx on public.recipes(visibility);
create index if not exists recipes_updated_at_idx on public.recipes(updated_at desc);
create index if not exists recipes_tags_idx on public.recipes using gin(tags);
create index if not exists recipes_share_token_idx on public.recipes(share_token);
create unique index if not exists recipes_share_token_unique_idx
  on public.recipes(share_token)
  where share_token is not null;

-- Backward-compatible migration for existing projects
alter table public.recipes add column if not exists tags text[] not null default '{}';
alter table public.recipes add column if not exists share_token text null;

update public.recipes
set tags = categories
where (tags is null or cardinality(tags) = 0)
  and categories is not null
  and cardinality(categories) > 0;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'recipes_visibility_check'
      and conrelid = 'public.recipes'::regclass
  ) then
    alter table public.recipes drop constraint recipes_visibility_check;
  end if;

  alter table public.recipes
    add constraint recipes_visibility_check
    check (visibility in ('private', 'public', 'link', 'invited'));
exception
  when duplicate_object then null;
end $$;

-- 2) Private notes table (owner-only access)
create table if not exists public.recipe_notes (
  recipe_id uuid primary key references public.recipes(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  notes text null,
  updated_at timestamptz not null default now()
);

create index if not exists recipe_notes_owner_id_idx on public.recipe_notes(owner_id);

-- 3) Recipe access table for invited mode
create table if not exists public.recipe_access (
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (recipe_id, user_id)
);

create index if not exists recipe_access_user_id_idx on public.recipe_access(user_id);
create index if not exists recipe_access_recipe_id_idx on public.recipe_access(recipe_id);

-- 4) Weekly menus table
create table if not exists public.weekly_menus (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  meal_data jsonb not null default '{}'::jsonb,
  cell_people_count jsonb not null default '{}'::jsonb,
  cooked_status jsonb not null default '{}'::jsonb,
  visibility text not null default 'private' check (visibility in ('private', 'public', 'link', 'invited')),
  share_token text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, week_start)
);

create index if not exists weekly_menus_owner_id_idx on public.weekly_menus(owner_id);
create index if not exists weekly_menus_visibility_idx on public.weekly_menus(visibility);
create index if not exists weekly_menus_week_start_idx on public.weekly_menus(week_start);
create index if not exists weekly_menus_share_token_idx on public.weekly_menus(share_token);
create unique index if not exists weekly_menus_share_token_unique_idx
  on public.weekly_menus(share_token)
  where share_token is not null;

alter table public.weekly_menus add column if not exists share_token text null;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'weekly_menus_visibility_check'
      and conrelid = 'public.weekly_menus'::regclass
  ) then
    alter table public.weekly_menus drop constraint weekly_menus_visibility_check;
  end if;

  alter table public.weekly_menus
    add constraint weekly_menus_visibility_check
    check (visibility in ('private', 'public', 'link', 'invited'));
exception
  when duplicate_object then null;
end $$;

-- 5) Weekly menu access table for invited mode
create table if not exists public.weekly_menu_access (
  menu_id uuid not null references public.weekly_menus(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (menu_id, user_id)
);

create index if not exists weekly_menu_access_user_id_idx on public.weekly_menu_access(user_id);
create index if not exists weekly_menu_access_menu_id_idx on public.weekly_menu_access(menu_id);

-- 6) Auto-update updated_at
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

drop trigger if exists recipe_access_set_updated_at on public.recipe_access;
create trigger recipe_access_set_updated_at
before update on public.recipe_access
for each row execute function public.set_updated_at();

drop trigger if exists weekly_menus_set_updated_at on public.weekly_menus;
create trigger weekly_menus_set_updated_at
before update on public.weekly_menus
for each row execute function public.set_updated_at();

drop trigger if exists weekly_menu_access_set_updated_at on public.weekly_menu_access;
create trigger weekly_menu_access_set_updated_at
before update on public.weekly_menu_access
for each row execute function public.set_updated_at();

-- 7) RLS
alter table public.recipes enable row level security;
alter table public.recipe_notes enable row level security;
alter table public.recipe_access enable row level security;
alter table public.weekly_menus enable row level security;
alter table public.weekly_menu_access enable row level security;

-- recipes policies
drop policy if exists "recipes_select_with_visibility" on public.recipes;
create policy "recipes_select_with_visibility"
on public.recipes
for select
using (
  owner_id = auth.uid()
  or visibility = 'public'
  or (visibility = 'link' and share_token is not null and length(share_token) > 0)
  or (
    visibility = 'invited'
    and auth.uid() is not null
    and exists (
      select 1
      from public.recipe_access access_row
      where access_row.recipe_id = recipes.id
        and access_row.user_id = auth.uid()
    )
  )
);

drop policy if exists "recipes_select_own_or_public" on public.recipes;

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

-- recipe_access policies
drop policy if exists "recipe_access_select_owner_or_invited" on public.recipe_access;
create policy "recipe_access_select_owner_or_invited"
on public.recipe_access
for select
using (
  user_id = auth.uid()
  or exists (
    select 1
    from public.recipes r
    where r.id = recipe_access.recipe_id
      and r.owner_id = auth.uid()
  )
);

drop policy if exists "recipe_access_insert_owner" on public.recipe_access;
create policy "recipe_access_insert_owner"
on public.recipe_access
for insert
with check (
  exists (
    select 1
    from public.recipes r
    where r.id = recipe_access.recipe_id
      and r.owner_id = auth.uid()
  )
);

drop policy if exists "recipe_access_update_owner" on public.recipe_access;
create policy "recipe_access_update_owner"
on public.recipe_access
for update
using (
  exists (
    select 1
    from public.recipes r
    where r.id = recipe_access.recipe_id
      and r.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.recipes r
    where r.id = recipe_access.recipe_id
      and r.owner_id = auth.uid()
  )
);

drop policy if exists "recipe_access_delete_owner" on public.recipe_access;
create policy "recipe_access_delete_owner"
on public.recipe_access
for delete
using (
  exists (
    select 1
    from public.recipes r
    where r.id = recipe_access.recipe_id
      and r.owner_id = auth.uid()
  )
);

-- recipe_access helpers (email-based invitations)
create or replace function public.replace_recipe_access_by_email(
  p_recipe_id uuid,
  p_emails text[],
  p_role text default 'viewer'
)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_owner_id uuid;
  v_role text;
  v_count integer := 0;
begin
  select owner_id into v_owner_id
  from public.recipes
  where id = p_recipe_id;

  if v_owner_id is null then
    raise exception 'Recipe not found';
  end if;

  if auth.uid() is null or v_owner_id <> auth.uid() then
    raise exception 'Forbidden';
  end if;

  v_role := case when lower(coalesce(p_role, 'viewer')) = 'editor' then 'editor' else 'viewer' end;

  delete from public.recipe_access
  where recipe_id = p_recipe_id;

  if p_emails is null or array_length(p_emails, 1) is null then
    return 0;
  end if;

  insert into public.recipe_access (recipe_id, user_id, role)
  select
    p_recipe_id,
    auth_users.id,
    v_role
  from auth.users auth_users
  join (
    select distinct lower(trim(value)) as normalized_email
    from unnest(p_emails) as value
    where trim(value) <> ''
  ) incoming on lower(auth_users.email) = incoming.normalized_email
  where auth_users.email is not null
  on conflict (recipe_id, user_id)
  do update set
    role = excluded.role,
    updated_at = now();

  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

grant execute on function public.replace_recipe_access_by_email(uuid, text[], text) to authenticated;

create or replace function public.list_recipe_access_emails(
  p_recipe_id uuid
)
returns table(email text, role text)
language sql
security definer
set search_path = public, auth
as $$
  select
    auth_users.email::text as email,
    coalesce(access_row.role, 'viewer')::text as role
  from public.recipe_access access_row
  join public.recipes r on r.id = access_row.recipe_id
  join auth.users auth_users on auth_users.id = access_row.user_id
  where access_row.recipe_id = p_recipe_id
    and auth.uid() is not null
    and r.owner_id = auth.uid()
  order by auth_users.email asc;
$$;

grant execute on function public.list_recipe_access_emails(uuid) to authenticated;

-- weekly_menus policies
drop policy if exists "weekly_menus_select_with_visibility" on public.weekly_menus;
create policy "weekly_menus_select_with_visibility"
on public.weekly_menus
for select
using (
  owner_id = auth.uid()
  or visibility = 'public'
  or (visibility = 'link' and share_token is not null and length(share_token) > 0)
  or (
    visibility = 'invited'
    and auth.uid() is not null
    and exists (
      select 1
      from public.weekly_menu_access access_row
      where access_row.menu_id = weekly_menus.id
        and access_row.user_id = auth.uid()
    )
  )
);

drop policy if exists "weekly_menus_select_own_or_public" on public.weekly_menus;

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

-- weekly_menu_access policies
drop policy if exists "weekly_menu_access_select_owner_or_invited" on public.weekly_menu_access;
create policy "weekly_menu_access_select_owner_or_invited"
on public.weekly_menu_access
for select
using (
  user_id = auth.uid()
  or exists (
    select 1
    from public.weekly_menus menu_row
    where menu_row.id = weekly_menu_access.menu_id
      and menu_row.owner_id = auth.uid()
  )
);

drop policy if exists "weekly_menu_access_insert_owner" on public.weekly_menu_access;
create policy "weekly_menu_access_insert_owner"
on public.weekly_menu_access
for insert
with check (
  exists (
    select 1
    from public.weekly_menus menu_row
    where menu_row.id = weekly_menu_access.menu_id
      and menu_row.owner_id = auth.uid()
  )
);

drop policy if exists "weekly_menu_access_update_owner" on public.weekly_menu_access;
create policy "weekly_menu_access_update_owner"
on public.weekly_menu_access
for update
using (
  exists (
    select 1
    from public.weekly_menus menu_row
    where menu_row.id = weekly_menu_access.menu_id
      and menu_row.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.weekly_menus menu_row
    where menu_row.id = weekly_menu_access.menu_id
      and menu_row.owner_id = auth.uid()
  )
);

drop policy if exists "weekly_menu_access_delete_owner" on public.weekly_menu_access;
create policy "weekly_menu_access_delete_owner"
on public.weekly_menu_access
for delete
using (
  exists (
    select 1
    from public.weekly_menus menu_row
    where menu_row.id = weekly_menu_access.menu_id
      and menu_row.owner_id = auth.uid()
  )
);
