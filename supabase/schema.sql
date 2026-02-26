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
  or public.is_recipe_owner(recipe_access.recipe_id)
  or public.is_admin()
);

drop policy if exists "recipe_access_insert_owner" on public.recipe_access;
create policy "recipe_access_insert_owner"
on public.recipe_access
for insert
with check (
  public.is_recipe_owner(recipe_access.recipe_id)
  or public.is_admin()
);

drop policy if exists "recipe_access_update_owner" on public.recipe_access;
create policy "recipe_access_update_owner"
on public.recipe_access
for update
using (
  public.is_recipe_owner(recipe_access.recipe_id)
  or public.is_admin()
)
with check (
  public.is_recipe_owner(recipe_access.recipe_id)
  or public.is_admin()
);

drop policy if exists "recipe_access_delete_owner" on public.recipe_access;
create policy "recipe_access_delete_owner"
on public.recipe_access
for delete
using (
  public.is_recipe_owner(recipe_access.recipe_id)
  or public.is_admin()
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

create or replace function public.is_recipe_owner(p_recipe_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.recipes r
    where r.id = p_recipe_id
      and r.owner_id = auth.uid()
  );
$$;

grant execute on function public.is_recipe_owner(uuid) to authenticated;

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

-- =========================================================
-- Recipe i18n model (translation is NOT a new recipe)
-- =========================================================

alter table public.recipes add column if not exists base_language text not null default 'ru';

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'recipes_base_language_check'
      and conrelid = 'public.recipes'::regclass
  ) then
    alter table public.recipes drop constraint recipes_base_language_check;
  end if;
  alter table public.recipes
    add constraint recipes_base_language_check
    check (base_language in ('ru', 'en', 'es'));
end $$;

create table if not exists public.ingredient_categories (
  id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ingredient_category_translations (
  category_id text not null references public.ingredient_categories(id) on delete cascade,
  language text not null check (language in ('ru', 'en', 'es')),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (category_id, language)
);

create index if not exists ingredient_category_translations_language_idx
  on public.ingredient_category_translations(language);

create table if not exists public.ingredient_dictionary (
  id text primary key,
  category_id text not null default 'other',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ingredient_dictionary_category_fk'
      and conrelid = 'public.ingredient_dictionary'::regclass
  ) then
    alter table public.ingredient_dictionary
      add constraint ingredient_dictionary_category_fk
      foreign key (category_id)
      references public.ingredient_categories(id)
      on update cascade
      on delete restrict;
  end if;
exception
  when duplicate_object then null;
end $$;

create table if not exists public.ingredient_translations (
  ingredient_id text not null references public.ingredient_dictionary(id) on delete cascade,
  language text not null check (language in ('ru', 'en', 'es')),
  name text not null,
  aliases text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (ingredient_id, language)
);

create index if not exists ingredient_translations_name_idx
  on public.ingredient_translations (language, name);

create table if not exists public.recipe_translations (
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  language text not null check (language in ('ru', 'en', 'es')),
  title text not null,
  short_description text null default '',
  description text null default '',
  instructions text null default '',
  is_auto_generated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (recipe_id, language)
);

create index if not exists recipe_translations_language_idx
  on public.recipe_translations(language);
create index if not exists recipes_base_language_idx
  on public.recipes(base_language);

-- =========================================================
-- Admin + user profiles
-- =========================================================

create table if not exists public.admin_users (
  email text primary key,
  note text null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text null,
  ui_language text not null default 'ru' check (ui_language in ('ru', 'en', 'es')),
  plan_tier text not null default 'free' check (plan_tier in ('free', 'pro')),
  subscription_status text not null default 'inactive' check (subscription_status in ('inactive', 'trial', 'active', 'past_due', 'canceled')),
  is_blocked boolean not null default false,
  is_test_access boolean not null default false,
  pro_expires_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists user_profiles_email_unique_idx
  on public.user_profiles(lower(email));

create index if not exists user_profiles_plan_tier_idx
  on public.user_profiles(plan_tier);

create index if not exists user_profiles_subscription_status_idx
  on public.user_profiles(subscription_status);

create or replace function public.is_admin()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email = '' then
    return false;
  end if;

  return exists (
    select 1
    from public.admin_users admin_row
    where lower(admin_row.email) = v_email
  );
end;
$$;

grant execute on function public.is_admin() to authenticated;

create or replace function public.upsert_my_profile(
  p_email text default null,
  p_display_name text default null,
  p_ui_language text default 'ru'
)
returns public.user_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_email text;
  v_display_name text;
  v_ui_language text;
  v_row public.user_profiles;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Forbidden';
  end if;

  v_email := lower(
    coalesce(
      nullif(trim(coalesce(p_email, '')), ''),
      nullif(trim(coalesce(auth.jwt() ->> 'email', '')), '')
    )
  );
  if v_email is null or v_email = '' then
    raise exception 'Email is required';
  end if;

  v_display_name := nullif(trim(coalesce(p_display_name, '')), '');
  v_ui_language := case
    when p_ui_language in ('ru', 'en', 'es') then p_ui_language
    else 'ru'
  end;

  insert into public.user_profiles (
    user_id,
    email,
    display_name,
    ui_language
  ) values (
    v_user_id,
    v_email,
    v_display_name,
    v_ui_language
  )
  on conflict (user_id) do update
  set
    email = excluded.email,
    display_name = coalesce(excluded.display_name, public.user_profiles.display_name),
    ui_language = excluded.ui_language,
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.upsert_my_profile(text, text, text) to authenticated;

create or replace function public.admin_merge_ingredients(
  p_source_id text,
  p_target_id text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_id text;
  v_target_id text;
  v_updated_recipes_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Forbidden';
  end if;

  v_source_id := trim(coalesce(p_source_id, ''));
  v_target_id := trim(coalesce(p_target_id, ''));

  if v_source_id = '' or v_target_id = '' then
    raise exception 'Ingredient ids are required';
  end if;

  if v_source_id = v_target_id then
    return 0;
  end if;

  if not exists (select 1 from public.ingredient_dictionary where id = v_source_id) then
    raise exception 'Source ingredient not found';
  end if;

  if not exists (select 1 from public.ingredient_dictionary where id = v_target_id) then
    raise exception 'Target ingredient not found';
  end if;

  update public.recipes r
  set ingredients = coalesce((
    select jsonb_agg(
      case
        when jsonb_typeof(item) = 'object'
          and (
            item ->> 'ingredientId' = v_source_id
            or item ->> 'ingredient_id' = v_source_id
          ) then
          jsonb_set(
            jsonb_set(item, '{ingredientId}', to_jsonb(v_target_id), true),
            '{ingredient_id}', to_jsonb(v_target_id), true
          )
        else item
      end
    )
    from jsonb_array_elements(coalesce(r.ingredients, '[]'::jsonb)) item
  ), '[]'::jsonb)
  where exists (
    select 1
    from jsonb_array_elements(coalesce(r.ingredients, '[]'::jsonb)) item
    where
      item ->> 'ingredientId' = v_source_id
      or item ->> 'ingredient_id' = v_source_id
  );

  get diagnostics v_updated_recipes_count = row_count;

  insert into public.ingredient_translations (ingredient_id, language, name, aliases)
  select v_target_id, language, name, aliases
  from public.ingredient_translations
  where ingredient_id = v_source_id
  on conflict (ingredient_id, language) do nothing;

  delete from public.ingredient_translations
  where ingredient_id = v_source_id;

  delete from public.ingredient_dictionary
  where id = v_source_id;

  return coalesce(v_updated_recipes_count, 0);
end;
$$;

grant execute on function public.admin_merge_ingredients(text, text) to authenticated;

drop trigger if exists ingredient_categories_set_updated_at on public.ingredient_categories;
create trigger ingredient_categories_set_updated_at
before update on public.ingredient_categories
for each row execute function public.set_updated_at();

drop trigger if exists ingredient_category_translations_set_updated_at on public.ingredient_category_translations;
create trigger ingredient_category_translations_set_updated_at
before update on public.ingredient_category_translations
for each row execute function public.set_updated_at();

drop trigger if exists ingredient_dictionary_set_updated_at on public.ingredient_dictionary;
create trigger ingredient_dictionary_set_updated_at
before update on public.ingredient_dictionary
for each row execute function public.set_updated_at();

drop trigger if exists ingredient_translations_set_updated_at on public.ingredient_translations;
create trigger ingredient_translations_set_updated_at
before update on public.ingredient_translations
for each row execute function public.set_updated_at();

drop trigger if exists recipe_translations_set_updated_at on public.recipe_translations;
create trigger recipe_translations_set_updated_at
before update on public.recipe_translations
for each row execute function public.set_updated_at();

drop trigger if exists user_profiles_set_updated_at on public.user_profiles;
create trigger user_profiles_set_updated_at
before update on public.user_profiles
for each row execute function public.set_updated_at();

alter table public.ingredient_dictionary enable row level security;
alter table public.ingredient_categories enable row level security;
alter table public.ingredient_category_translations enable row level security;
alter table public.ingredient_translations enable row level security;
alter table public.recipe_translations enable row level security;
alter table public.admin_users enable row level security;
alter table public.user_profiles enable row level security;

drop policy if exists "ingredient_categories_select_all" on public.ingredient_categories;
create policy "ingredient_categories_select_all"
on public.ingredient_categories
for select
using (true);

drop policy if exists "ingredient_category_translations_select_all" on public.ingredient_category_translations;
create policy "ingredient_category_translations_select_all"
on public.ingredient_category_translations
for select
using (true);

drop policy if exists "ingredient_dictionary_select_all" on public.ingredient_dictionary;
create policy "ingredient_dictionary_select_all"
on public.ingredient_dictionary
for select
using (true);

drop policy if exists "ingredient_translations_select_all" on public.ingredient_translations;
create policy "ingredient_translations_select_all"
on public.ingredient_translations
for select
using (true);

drop policy if exists "recipe_translations_select_with_recipe_access" on public.recipe_translations;
create policy "recipe_translations_select_with_recipe_access"
on public.recipe_translations
for select
using (
  exists (
    select 1
    from public.recipes r
    where r.id = recipe_translations.recipe_id
      and (
        r.owner_id = auth.uid()
        or r.visibility = 'public'
        or (r.visibility = 'link' and r.share_token is not null and length(r.share_token) > 0)
        or exists (
          select 1
          from public.recipe_access ra
          where ra.recipe_id = r.id
            and ra.user_id = auth.uid()
        )
      )
  )
);

drop policy if exists "recipe_translations_insert_owner" on public.recipe_translations;
create policy "recipe_translations_insert_owner"
on public.recipe_translations
for insert
with check (
  exists (
    select 1
    from public.recipes r
    where r.id = recipe_translations.recipe_id
      and r.owner_id = auth.uid()
  )
);

drop policy if exists "recipe_translations_update_owner" on public.recipe_translations;
create policy "recipe_translations_update_owner"
on public.recipe_translations
for update
using (
  exists (
    select 1
    from public.recipes r
    where r.id = recipe_translations.recipe_id
      and r.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.recipes r
    where r.id = recipe_translations.recipe_id
      and r.owner_id = auth.uid()
  )
);

drop policy if exists "recipe_translations_delete_owner" on public.recipe_translations;
create policy "recipe_translations_delete_owner"
on public.recipe_translations
for delete
using (
  exists (
    select 1
    from public.recipes r
    where r.id = recipe_translations.recipe_id
      and r.owner_id = auth.uid()
  )
);

drop policy if exists "admin_users_select_admin" on public.admin_users;
create policy "admin_users_select_admin"
on public.admin_users
for select
using (public.is_admin());

drop policy if exists "admin_users_insert_admin" on public.admin_users;
create policy "admin_users_insert_admin"
on public.admin_users
for insert
with check (public.is_admin());

drop policy if exists "admin_users_update_admin" on public.admin_users;
create policy "admin_users_update_admin"
on public.admin_users
for update
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "admin_users_delete_admin" on public.admin_users;
create policy "admin_users_delete_admin"
on public.admin_users
for delete
using (public.is_admin());

drop policy if exists "user_profiles_select_self_or_admin" on public.user_profiles;
create policy "user_profiles_select_self_or_admin"
on public.user_profiles
for select
using (
  user_id = auth.uid()
  or public.is_admin()
);

drop policy if exists "user_profiles_update_admin" on public.user_profiles;
create policy "user_profiles_update_admin"
on public.user_profiles
for update
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "user_profiles_insert_admin" on public.user_profiles;
create policy "user_profiles_insert_admin"
on public.user_profiles
for insert
with check (public.is_admin());

drop policy if exists "recipes_select_admin" on public.recipes;
create policy "recipes_select_admin"
on public.recipes
for select
using (public.is_admin());

drop policy if exists "recipes_update_admin" on public.recipes;
create policy "recipes_update_admin"
on public.recipes
for update
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "recipes_delete_admin" on public.recipes;
create policy "recipes_delete_admin"
on public.recipes
for delete
using (public.is_admin());

drop policy if exists "recipe_translations_select_admin" on public.recipe_translations;
create policy "recipe_translations_select_admin"
on public.recipe_translations
for select
using (public.is_admin());

drop policy if exists "recipe_translations_insert_admin" on public.recipe_translations;
create policy "recipe_translations_insert_admin"
on public.recipe_translations
for insert
with check (public.is_admin());

drop policy if exists "recipe_translations_update_admin" on public.recipe_translations;
create policy "recipe_translations_update_admin"
on public.recipe_translations
for update
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "recipe_translations_delete_admin" on public.recipe_translations;
create policy "recipe_translations_delete_admin"
on public.recipe_translations
for delete
using (public.is_admin());

drop policy if exists "ingredient_dictionary_insert_admin" on public.ingredient_dictionary;
create policy "ingredient_dictionary_insert_admin"
on public.ingredient_dictionary
for insert
with check (public.is_admin());

drop policy if exists "ingredient_dictionary_update_admin" on public.ingredient_dictionary;
create policy "ingredient_dictionary_update_admin"
on public.ingredient_dictionary
for update
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "ingredient_dictionary_delete_admin" on public.ingredient_dictionary;
create policy "ingredient_dictionary_delete_admin"
on public.ingredient_dictionary
for delete
using (public.is_admin());

drop policy if exists "ingredient_translations_insert_admin" on public.ingredient_translations;
create policy "ingredient_translations_insert_admin"
on public.ingredient_translations
for insert
with check (public.is_admin());

drop policy if exists "ingredient_translations_update_admin" on public.ingredient_translations;
create policy "ingredient_translations_update_admin"
on public.ingredient_translations
for update
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "ingredient_translations_delete_admin" on public.ingredient_translations;
create policy "ingredient_translations_delete_admin"
on public.ingredient_translations
for delete
using (public.is_admin());

drop policy if exists "ingredient_categories_insert_admin" on public.ingredient_categories;
create policy "ingredient_categories_insert_admin"
on public.ingredient_categories
for insert
with check (public.is_admin());

drop policy if exists "ingredient_categories_update_admin" on public.ingredient_categories;
create policy "ingredient_categories_update_admin"
on public.ingredient_categories
for update
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "ingredient_category_translations_insert_admin" on public.ingredient_category_translations;
create policy "ingredient_category_translations_insert_admin"
on public.ingredient_category_translations
for insert
with check (public.is_admin());

drop policy if exists "ingredient_category_translations_update_admin" on public.ingredient_category_translations;
create policy "ingredient_category_translations_update_admin"
on public.ingredient_category_translations
for update
using (public.is_admin())
with check (public.is_admin());

-- Starter dictionary seed
insert into public.ingredient_categories (id) values
  ('vegetables'),
  ('fruits'),
  ('protein'),
  ('dairy'),
  ('grocery'),
  ('bakery'),
  ('drinks'),
  ('other')
on conflict (id) do nothing;

insert into public.ingredient_category_translations (category_id, language, name) values
  ('vegetables', 'ru', 'Овощи'),
  ('vegetables', 'en', 'Vegetables'),
  ('vegetables', 'es', 'Verduras'),
  ('fruits', 'ru', 'Фрукты'),
  ('fruits', 'en', 'Fruits'),
  ('fruits', 'es', 'Frutas'),
  ('protein', 'ru', 'Белок'),
  ('protein', 'en', 'Protein'),
  ('protein', 'es', 'Proteína'),
  ('dairy', 'ru', 'Молочное'),
  ('dairy', 'en', 'Dairy'),
  ('dairy', 'es', 'Lácteos'),
  ('grocery', 'ru', 'Бакалея'),
  ('grocery', 'en', 'Grocery'),
  ('grocery', 'es', 'Despensa seca'),
  ('bakery', 'ru', 'Выпечка'),
  ('bakery', 'en', 'Bakery'),
  ('bakery', 'es', 'Panadería'),
  ('drinks', 'ru', 'Напитки'),
  ('drinks', 'en', 'Drinks'),
  ('drinks', 'es', 'Bebidas'),
  ('other', 'ru', 'Прочее'),
  ('other', 'en', 'Other'),
  ('other', 'es', 'Otros')
on conflict (category_id, language) do update
set
  name = excluded.name,
  updated_at = now();

insert into public.ingredient_dictionary (id, category_id) values
  ('milk', 'dairy'),
  ('cottage_cheese', 'dairy'),
  ('egg', 'protein'),
  ('chicken_fillet', 'protein'),
  ('salmon', 'protein'),
  ('rice', 'grocery'),
  ('oats', 'grocery'),
  ('pasta', 'grocery'),
  ('potato', 'vegetables'),
  ('tomato', 'vegetables'),
  ('cucumber', 'vegetables'),
  ('onion', 'vegetables'),
  ('garlic', 'vegetables'),
  ('banana', 'fruits'),
  ('apple', 'fruits')
on conflict (id) do nothing;

insert into public.ingredient_translations (ingredient_id, language, name, aliases) values
  ('milk', 'ru', 'Молоко', '{молоко}'),
  ('milk', 'en', 'Milk', '{milk}'),
  ('milk', 'es', 'Leche', '{leche}'),
  ('cottage_cheese', 'ru', 'Творог', '{творог}'),
  ('cottage_cheese', 'en', 'Cottage cheese', '{cottage cheese}'),
  ('cottage_cheese', 'es', 'Requeson', '{requeson}'),
  ('egg', 'ru', 'Яйцо', '{яйцо,яйца}'),
  ('egg', 'en', 'Egg', '{egg,eggs}'),
  ('egg', 'es', 'Huevo', '{huevo,huevos}'),
  ('chicken_fillet', 'ru', 'Куриное филе', '{курица,куриное филе}'),
  ('chicken_fillet', 'en', 'Chicken fillet', '{chicken fillet,chicken breast}'),
  ('chicken_fillet', 'es', 'Pechuga de pollo', '{pollo,pechuga de pollo}'),
  ('salmon', 'ru', 'Лосось', '{лосось,филе лосося}'),
  ('salmon', 'en', 'Salmon', '{salmon}'),
  ('salmon', 'es', 'Salmon', '{salmon}'),
  ('rice', 'ru', 'Рис', '{рис}'),
  ('rice', 'en', 'Rice', '{rice}'),
  ('rice', 'es', 'Arroz', '{arroz}'),
  ('oats', 'ru', 'Овсяные хлопья', '{овсянка,овсяные хлопья}'),
  ('oats', 'en', 'Oats', '{oats,oatmeal}'),
  ('oats', 'es', 'Avena', '{avena}'),
  ('pasta', 'ru', 'Паста', '{паста,макароны}'),
  ('pasta', 'en', 'Pasta', '{pasta}'),
  ('pasta', 'es', 'Pasta', '{pasta}'),
  ('potato', 'ru', 'Картофель', '{картофель,картошка}'),
  ('potato', 'en', 'Potato', '{potato,potatoes}'),
  ('potato', 'es', 'Patata', '{patata,patatas}'),
  ('tomato', 'ru', 'Помидор', '{помидор,томаты}'),
  ('tomato', 'en', 'Tomato', '{tomato,tomatoes}'),
  ('tomato', 'es', 'Tomate', '{tomate,tomates}'),
  ('cucumber', 'ru', 'Огурец', '{огурец,огурцы}'),
  ('cucumber', 'en', 'Cucumber', '{cucumber,cucumbers}'),
  ('cucumber', 'es', 'Pepino', '{pepino,pepinos}'),
  ('onion', 'ru', 'Лук', '{лук}'),
  ('onion', 'en', 'Onion', '{onion,onions}'),
  ('onion', 'es', 'Cebolla', '{cebolla,cebollas}'),
  ('garlic', 'ru', 'Чеснок', '{чеснок}'),
  ('garlic', 'en', 'Garlic', '{garlic}'),
  ('garlic', 'es', 'Ajo', '{ajo}'),
  ('banana', 'ru', 'Банан', '{банан,бананы}'),
  ('banana', 'en', 'Banana', '{banana,bananas}'),
  ('banana', 'es', 'Platano', '{platano,platanos}'),
  ('apple', 'ru', 'Яблоко', '{яблоко,яблоки}'),
  ('apple', 'en', 'Apple', '{apple,apples}'),
  ('apple', 'es', 'Manzana', '{manzana,manzanas}')
on conflict (ingredient_id, language) do update
set
  name = excluded.name,
  aliases = excluded.aliases,
  updated_at = now();
