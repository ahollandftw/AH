-- Stat tables aligned with CSV files in /data (player_id = Statcast id string).
-- Import via: npm run import:stats (from repo root; requires SUPABASE_SERVICE_ROLE_KEY).

-- b.homeruns*.csv / p.homeruns*.csv
create table if not exists public.stats_homeruns (
  role text not null check (role in ('batting', 'pitching')),
  player_id text not null,
  player_display text,
  team_abbrev text,
  year int not null,
  type text not null,
  avg_hr_trot numeric,
  doubters int,
  mostly_gone int,
  no_doubters int,
  no_doubter_per numeric,
  hr_total int,
  xhr numeric,
  xhr_diff numeric,
  primary key (role, player_id, year, type)
);

create index if not exists stats_homeruns_player_id_idx on public.stats_homeruns (player_id);

-- b.exit_velocity*.csv / p.exit_velocity*.csv (year from filename)
create table if not exists public.stats_exit_velocity (
  role text not null check (role in ('batting', 'pitching')),
  player_id text not null,
  season int not null,
  last_name_first_name text,
  attempts int,
  avg_hit_angle numeric,
  anglesweetspotpercent numeric,
  max_hit_speed numeric,
  avg_hit_speed numeric,
  ev50 numeric,
  fbld numeric,
  gb numeric,
  max_distance int,
  avg_distance int,
  avg_hr_distance int,
  ev95plus int,
  ev95percent numeric,
  barrels int,
  brl_percent numeric,
  brl_pa numeric,
  primary key (role, player_id, season)
);

create index if not exists stats_exit_velocity_player_id_idx on public.stats_exit_velocity (player_id);

-- b.pitch-arsenal-stats*.csv / p.pitch-arsenal-stats*.csv
create table if not exists public.stats_pitch_arsenal (
  role text not null check (role in ('batting', 'pitching')),
  player_id text not null,
  season int not null,
  last_name_first_name text,
  team_name_alt text,
  pitch_type text not null default '',
  pitch_name text not null default '',
  run_value_per_100 numeric,
  run_value numeric,
  pitches int,
  pitch_usage numeric,
  pa int,
  ba numeric,
  slg numeric,
  woba numeric,
  whiff_percent numeric,
  k_percent numeric,
  put_away numeric,
  est_ba numeric,
  est_slg numeric,
  est_woba numeric,
  hard_hit_percent numeric,
  primary key (role, player_id, season, pitch_type, pitch_name)
);

create index if not exists stats_pitch_arsenal_player_id_idx on public.stats_pitch_arsenal (player_id);

-- b.standard2019through2025.csv / p.standard2019through2025.csv
create table if not exists public.stats_standard (
  role text not null check (role in ('batting', 'pitching')),
  player_id text not null,
  player_name text,
  team_abbrev text,
  name_ascii text,
  mlbam_id bigint,
  g int,
  ab int,
  pa int,
  hr int,
  ip numeric,
  tbf int,
  stats jsonb not null default '{}'::jsonb,
  primary key (role, player_id)
);

create index if not exists stats_standard_player_id_idx on public.stats_standard (player_id);
create index if not exists stats_standard_team_abbrev_idx on public.stats_standard (team_abbrev);

alter table public.stats_homeruns enable row level security;
alter table public.stats_exit_velocity enable row level security;
alter table public.stats_pitch_arsenal enable row level security;
alter table public.stats_standard enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stats_homeruns' and policyname = 'stats_homeruns_select') then
    create policy stats_homeruns_select on public.stats_homeruns for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stats_exit_velocity' and policyname = 'stats_exit_velocity_select') then
    create policy stats_exit_velocity_select on public.stats_exit_velocity for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stats_pitch_arsenal' and policyname = 'stats_pitch_arsenal_select') then
    create policy stats_pitch_arsenal_select on public.stats_pitch_arsenal for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stats_standard' and policyname = 'stats_standard_select') then
    create policy stats_standard_select on public.stats_standard for select using (true);
  end if;
end $$;
