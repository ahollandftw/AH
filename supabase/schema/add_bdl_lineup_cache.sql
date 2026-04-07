-- Persistent lineup cache so lineups are served from DB instead of hitting BDL API on every page load.
-- Run once on your Supabase project: Settings → SQL Editor → paste & run.

create table if not exists public.bdl_lineup_cache (
  game_id      integer primary key,
  date         text    not null,
  home_lineup  jsonb   not null default '[]',
  away_lineup  jsonb   not null default '[]',
  home_pitcher jsonb,
  away_pitcher jsonb,
  home_source  text    not null default 'none',
  away_source  text    not null default 'none',
  fetched_at   timestamptz not null default now()
);

create index if not exists bdl_lineup_cache_date_idx on public.bdl_lineup_cache(date);

alter table public.bdl_lineup_cache enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename   = 'bdl_lineup_cache'
      and policyname  = 'bdl_lineup_cache_select'
  ) then
    create policy bdl_lineup_cache_select
      on public.bdl_lineup_cache
      for select using (true);
  end if;
end $$;
