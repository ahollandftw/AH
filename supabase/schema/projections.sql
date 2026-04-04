-- Daily projections + top picks schema for AnalyticHustle.
-- Run in Supabase SQL Editor after launch_lab.sql.
-- player_id references players.stat_player_id (Statcast id string).

create extension if not exists pgcrypto;

create table if not exists public.daily_hr_projections (
  id uuid primary key default gen_random_uuid(),
  date date not null default current_date,
  player_id text not null references public.players (stat_player_id) on delete cascade,
  opponent_pitcher text,
  opponent_pitcher_hand text,
  hr_probability numeric,
  l7_hrs int,
  tier text,
  model_variant text not null default 'default'
    check (model_variant in ('default', 'weighted_pitch_arsenal', 'contact_quality')),
  created_at timestamptz not null default now(),
  unique (date, player_id, model_variant)
);

alter table public.daily_hr_projections enable row level security;

-- Public read so the app can render without requiring login for projections.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'daily_hr_projections' and policyname = 'daily_hr_projections_public_select'
  ) then
    create policy daily_hr_projections_public_select
    on public.daily_hr_projections
    for select
    using (true);
  end if;
end $$;

-- Seed example rows for today (requires players from launch_lab.sql + Judge below).
do $$
begin
  insert into public.players (slug, name, team, position, image_url, stat_player_id)
  values (
    'aaron-judge',
    'Aaron Judge',
    'New York Yankees',
    'CF',
    null,
    '592450'
  )
  on conflict (stat_player_id) do update
  set
    name = excluded.name,
    team = excluded.team,
    position = excluded.position,
    slug = excluded.slug;

  insert into public.daily_hr_projections (
    date,
    player_id,
    opponent_pitcher,
    opponent_pitcher_hand,
    hr_probability,
    l7_hrs,
    tier,
    model_variant
  )
  values (
    current_date,
    '660271',
    'Gerrit Cole',
    'RHP',
    0.28,
    2,
    'S',
    'default'
  )
  on conflict (date, player_id, model_variant) do update
  set
    opponent_pitcher = excluded.opponent_pitcher,
    opponent_pitcher_hand = excluded.opponent_pitcher_hand,
    hr_probability = excluded.hr_probability,
    l7_hrs = excluded.l7_hrs,
    tier = excluded.tier;

  insert into public.daily_hr_projections (
    date,
    player_id,
    opponent_pitcher,
    opponent_pitcher_hand,
    hr_probability,
    l7_hrs,
    tier,
    model_variant
  )
  values (
    current_date,
    '592450',
    'Chris Sale',
    'LHP',
    0.22,
    4,
    'A',
    'default'
  )
  on conflict (date, player_id, model_variant) do update
  set
    opponent_pitcher = excluded.opponent_pitcher,
    opponent_pitcher_hand = excluded.opponent_pitcher_hand,
    hr_probability = excluded.hr_probability,
    l7_hrs = excluded.l7_hrs,
    tier = excluded.tier;
end $$;
