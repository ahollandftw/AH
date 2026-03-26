-- Profile/social foundation for AnalyticHustle web accounts.
-- Run after watchlist.sql and patch_user_settings_favorite_team.sql.

alter table public.user_settings
  add column if not exists display_name text,
  add column if not exists avatar_url text,
  add column if not exists profile_visibility text not null default 'private';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_settings_profile_visibility_check'
  ) then
    alter table public.user_settings
      add constraint user_settings_profile_visibility_check
      check (profile_visibility in ('public', 'friends', 'private'));
  end if;
end $$;

create table if not exists public.user_friendships (
  user_id uuid not null references auth.users(id) on delete cascade,
  friend_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, friend_user_id),
  check (user_id <> friend_user_id),
  check (status in ('pending', 'accepted', 'blocked'))
);

alter table public.user_friendships enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_friendships' and policyname = 'user_friendships_select_member'
  ) then
    create policy user_friendships_select_member
    on public.user_friendships
    for select
    using (auth.uid() = user_id or auth.uid() = friend_user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_friendships' and policyname = 'user_friendships_insert_owner'
  ) then
    create policy user_friendships_insert_owner
    on public.user_friendships
    for insert
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_friendships' and policyname = 'user_friendships_update_member'
  ) then
    create policy user_friendships_update_member
    on public.user_friendships
    for update
    using (auth.uid() = user_id or auth.uid() = friend_user_id)
    with check (auth.uid() = user_id or auth.uid() = friend_user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_friendships' and policyname = 'user_friendships_delete_owner'
  ) then
    create policy user_friendships_delete_owner
    on public.user_friendships
    for delete
    using (auth.uid() = user_id);
  end if;
end $$;

drop trigger if exists user_friendships_set_updated_at on public.user_friendships;
create trigger user_friendships_set_updated_at
before update on public.user_friendships
for each row execute function public.set_updated_at();

create table if not exists public.user_stat_snapshots (
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_date date not null default current_date,
  watchlist_count integer not null default 0,
  favorite_team text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, snapshot_date)
);

alter table public.user_stat_snapshots enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_stat_snapshots' and policyname = 'user_stat_snapshots_select_own'
  ) then
    create policy user_stat_snapshots_select_own
    on public.user_stat_snapshots
    for select
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_stat_snapshots' and policyname = 'user_stat_snapshots_upsert_own'
  ) then
    create policy user_stat_snapshots_upsert_own
    on public.user_stat_snapshots
    for insert
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_stat_snapshots' and policyname = 'user_stat_snapshots_update_own'
  ) then
    create policy user_stat_snapshots_update_own
    on public.user_stat_snapshots
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
  end if;
end $$;

drop trigger if exists user_stat_snapshots_set_updated_at on public.user_stat_snapshots;
create trigger user_stat_snapshots_set_updated_at
before update on public.user_stat_snapshots
for each row execute function public.set_updated_at();
