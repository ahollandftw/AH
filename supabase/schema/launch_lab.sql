-- Launch Lab schema for AnalyticHustle.
-- Run in Supabase SQL Editor (once), then the mobile/web Launch Lab screen can query it.
-- Canonical player key: stat_player_id (MLB Statcast id string, e.g. '660271').

create extension if not exists pgcrypto;

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  stat_player_id text not null unique,
  slug text not null unique,
  name text not null,
  team text,
  position text,
  image_url text,
  created_at timestamptz not null default now()
);

-- Existing databases: if `players` was created from an older script, it has no stat_player_id.
-- `CREATE TABLE IF NOT EXISTS` does not add new columns — only this ALTER does.
alter table public.players add column if not exists stat_player_id text;

update public.players set stat_player_id = '660271' where slug = 'shohei-ohtani' and (stat_player_id is null or stat_player_id = '');
update public.players set stat_player_id = '592450' where slug = 'aaron-judge' and (stat_player_id is null or stat_player_id = '');
update public.players set stat_player_id = 'legacy-' || id::text where stat_player_id is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'players_stat_player_id_key' and conrelid = 'public.players'::regclass
  ) then
    alter table public.players add constraint players_stat_player_id_key unique (stat_player_id);
  end if;
end $$;

alter table public.players alter column stat_player_id set not null;

create table if not exists public.player_launchlab_projections (
  id uuid primary key default gen_random_uuid(),
  player_id text not null references public.players (stat_player_id) on delete cascade,
  date date not null default current_date,
  season_hr_projection numeric,
  season_hr_vs_avg numeric,
  vertical_launch_vector_degrees numeric,
  sweet_spot_percentage numeric,
  optimal_hr_zone_label text,
  consistency_score numeric,
  exit_velocity_mph numeric,
  created_at timestamptz not null default now(),
  unique (player_id, date)
);

alter table public.players enable row level security;
alter table public.player_launchlab_projections enable row level security;

-- Public read so the anon key can render the app immediately.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'players' and policyname = 'players_public_select'
  ) then
    create policy players_public_select
    on public.players
    for select
    using (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'player_launchlab_projections' and policyname = 'launchlab_public_select'
  ) then
    create policy launchlab_public_select
    on public.player_launchlab_projections
    for select
    using (true);
  end if;
end $$;

-- Seed example data (Statcast id 660271 = Shohei Ohtani).
do $$
begin
  insert into public.players (slug, name, team, position, image_url, stat_player_id)
  values (
    'shohei-ohtani',
    'Shohei Ohtani',
    'Los Angeles Dodgers',
    'DH / P',
    null,
    '660271'
  )
  on conflict (stat_player_id) do update
  set
    name = excluded.name,
    team = excluded.team,
    position = excluded.position,
    slug = excluded.slug;
end $$;

-- Only when player_launchlab_projections already uses text player_id (Statcast id).
-- If your DB still has uuid player_id here, run migrate_stat_player_id.sql next, then re-run this block or insert manually.
do $$
declare
  dt text;
begin
  select c.data_type into dt
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'player_launchlab_projections'
    and c.column_name = 'player_id';

  if dt = 'text' then
    insert into public.player_launchlab_projections (
      player_id,
      date,
      season_hr_projection,
      season_hr_vs_avg,
      vertical_launch_vector_degrees,
      sweet_spot_percentage,
      optimal_hr_zone_label,
      consistency_score,
      exit_velocity_mph
    )
    values (
      '660271',
      current_date,
      54,
      4.2,
      12.2,
      12.2,
      '24° - 32°',
      94.2,
      118.4
    )
    on conflict (player_id, date) do update
    set
      season_hr_projection = excluded.season_hr_projection,
      season_hr_vs_avg = excluded.season_hr_vs_avg,
      vertical_launch_vector_degrees = excluded.vertical_launch_vector_degrees,
      sweet_spot_percentage = excluded.sweet_spot_percentage,
      optimal_hr_zone_label = excluded.optimal_hr_zone_label,
      consistency_score = excluded.consistency_score,
      exit_velocity_mph = excluded.exit_velocity_mph;
  end if;
end $$;
