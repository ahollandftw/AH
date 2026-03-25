-- Watchlist + settings schema for AnalyticHustle.
-- Run in Supabase SQL Editor after enabling Auth and launch_lab.sql.
-- watchlist_players.player_id = players.stat_player_id (Statcast id string).

create extension if not exists pgcrypto;

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  global_alerts_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.watchlist_players (
  user_id uuid not null references auth.users(id) on delete cascade,
  player_id text not null references public.players (stat_player_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, player_id)
);

alter table public.user_settings enable row level security;
alter table public.watchlist_players enable row level security;

-- user_settings: users can read/update their own row
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_settings' and policyname = 'user_settings_select_own'
  ) then
    create policy user_settings_select_own
    on public.user_settings
    for select
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_settings' and policyname = 'user_settings_upsert_own'
  ) then
    create policy user_settings_upsert_own
    on public.user_settings
    for insert
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_settings' and policyname = 'user_settings_update_own'
  ) then
    create policy user_settings_update_own
    on public.user_settings
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
  end if;
end $$;

-- watchlist_players: users can CRUD their own watchlist
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'watchlist_players' and policyname = 'watchlist_select_own'
  ) then
    create policy watchlist_select_own
    on public.watchlist_players
    for select
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'watchlist_players' and policyname = 'watchlist_insert_own'
  ) then
    create policy watchlist_insert_own
    on public.watchlist_players
    for insert
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'watchlist_players' and policyname = 'watchlist_delete_own'
  ) then
    create policy watchlist_delete_own
    on public.watchlist_players
    for delete
    using (auth.uid() = user_id);
  end if;
end $$;

-- Keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at
before update on public.user_settings
for each row execute function public.set_updated_at();
