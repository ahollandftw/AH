-- Daily Statcast ingestion + rolling aggregates (HR analytics).
-- Run in Supabase SQL Editor after core schemas.
-- Python ingestion + Node API use service role; public read for leaderboards.

create extension if not exists pgcrypto;

-- MLBAM player ids to pull from pybaseball (same integer as Statcast batter id).
create table if not exists public.tracked_players (
  player_id integer primary key,
  player_name text not null,
  team text,
  position text,
  created_at timestamptz not null default now()
);

create table if not exists public.player_stats_daily (
  id uuid primary key default gen_random_uuid(),
  player_id integer not null,
  player_name text,
  team text,
  position text,
  date date not null,
  plate_appearances integer not null default 0,
  home_runs integer not null default 0,
  barrels integer not null default 0,
  barrel_rate double precision,
  hard_hit_rate double precision,
  avg_exit_velo double precision,
  fly_ball_rate double precision,
  created_at timestamptz not null default now(),
  unique (player_id, date)
);

create index if not exists player_stats_daily_date_idx on public.player_stats_daily (date);
create index if not exists player_stats_daily_player_idx on public.player_stats_daily (player_id);

create table if not exists public.player_aggregates (
  player_id integer primary key,
  player_name text,
  team text,
  position text,
  sample_size_pa integer not null default 0,
  last3_barrel_rate double precision,
  last7_barrel_rate double precision,
  last14_barrel_rate double precision,
  season_barrel_rate double precision,
  last7_hard_hit_rate double precision,
  last7_avg_exit_velo double precision,
  hr_score double precision,
  expected_hr double precision,
  actual_hr integer not null default 0,
  hr_diff double precision,
  low_sample boolean not null default false,
  league_avg_barrel_rate double precision,
  barrel_plus double precision,
  updated_at timestamptz not null default now()
);

alter table public.tracked_players enable row level security;
alter table public.player_stats_daily enable row level security;
alter table public.player_aggregates enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tracked_players' and policyname = 'tracked_players_select_all') then
    create policy tracked_players_select_all on public.tracked_players for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'player_stats_daily' and policyname = 'player_stats_daily_select_all') then
    create policy player_stats_daily_select_all on public.player_stats_daily for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'player_aggregates' and policyname = 'player_aggregates_select_all') then
    create policy player_aggregates_select_all on public.player_aggregates for select using (true);
  end if;
end $$;

-- Seed a few tracked players (Ohtani, Judge) — extend via dashboard or insert.
insert into public.tracked_players (player_id, player_name, team, position)
values
  (660271, 'Shohei Ohtani', 'LAD', 'DH'),
  (592450, 'Aaron Judge', 'NYY', 'OF')
on conflict (player_id) do update
set player_name = excluded.player_name,
    team = excluded.team,
    position = excluded.position;
