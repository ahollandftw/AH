-- BallDontLie API integration tables for AnalyticHustle.
-- Cross-references BDL integer IDs with our Statcast player IDs.
-- Stores live game data, season stats, matchups, player props, and HR events.

-- ─── Player cross-reference ──────────────────────────────────────────
create table if not exists public.bdl_players (
  bdl_id       integer primary key,
  team_id      integer,
  stat_player_id text references public.players(stat_player_id),
  full_name    text not null,
  first_name   text,
  last_name    text,
  team_abbrev  text,
  position     text,
  bats_throws  text,
  synced_at    timestamptz not null default now()
);
create index if not exists bdl_players_stat_id_idx on public.bdl_players(stat_player_id);

-- ─── Games (for live monitoring) ─────────────────────────────────────
create table if not exists public.bdl_games (
  bdl_game_id       integer primary key,
  date              date not null,
  start_time_utc    timestamptz,
  home_team_abbrev  text not null,
  away_team_abbrev  text not null,
  home_team_name    text,
  away_team_name    text,
  status            text not null default 'Scheduled',
  scoring_summary   jsonb,
  home_score        integer default 0,
  away_score        integer default 0,
  home_hits         integer default 0,
  away_hits         integer default 0,
  home_errors       integer default 0,
  away_errors       integer default 0,
  venue             text,
  season            integer,
  last_play_order   integer default 0,
  synced_at         timestamptz not null default now()
);
create index if not exists bdl_games_date_idx on public.bdl_games(date);
create index if not exists bdl_games_status_idx on public.bdl_games(status);

-- ─── 2026 season stats ───────────────────────────────────────────────
create table if not exists public.bdl_season_stats (
  bdl_player_id  integer not null,
  season         integer not null,
  team_name      text,
  batting_gp     integer, batting_ab integer, batting_r  integer, batting_h  integer,
  batting_avg    numeric, batting_2b integer, batting_3b integer, batting_hr integer,
  batting_rbi    integer, batting_tb integer, batting_bb integer, batting_so integer,
  batting_sb     integer, batting_obp numeric, batting_slg numeric, batting_ops numeric,
  batting_war    numeric,
  pitching_gp    integer, pitching_gs integer, pitching_w integer, pitching_l integer,
  pitching_era   numeric, pitching_sv integer, pitching_ip numeric, pitching_h integer,
  pitching_er    integer, pitching_hr integer, pitching_bb integer, pitching_whip numeric,
  pitching_k     integer, pitching_k_per_9 numeric, pitching_war numeric,
  synced_at      timestamptz not null default now(),
  primary key (bdl_player_id, season)
);

-- ─── Batter-vs-pitcher matchup data ─────────────────────────────────
create table if not exists public.bdl_matchups (
  bdl_player_id          integer not null,
  opponent_bdl_player_id integer not null,
  opponent_team_id       integer,
  at_bats    integer, hits       integer, doubles    integer, triples    integer,
  home_runs  integer, rbi        integer, walks      integer, strikeouts integer,
  avg        numeric, obp        numeric, slg        numeric, ops        numeric,
  synced_at  timestamptz not null default now(),
  primary key (bdl_player_id, opponent_bdl_player_id)
);

-- ─── Player prop odds from sportsbooks ───────────────────────────────
create table if not exists public.bdl_player_props (
  id              serial primary key,
  bdl_game_id     integer not null,
  bdl_player_id   integer not null,
  vendor          text not null,
  prop_type       text not null,
  line_value      text,
  market_type     text,
  over_odds       integer,
  under_odds      integer,
  milestone_odds  integer,
  fetched_at      timestamptz not null default now()
);
create index if not exists bdl_props_game_idx on public.bdl_player_props(bdl_game_id);
create index if not exists bdl_props_player_idx on public.bdl_player_props(bdl_player_id);
create index if not exists bdl_props_vendor_idx on public.bdl_player_props(vendor, prop_type);

-- ─── Detected HR events for pick validation ─────────────────────────
create table if not exists public.bdl_hr_events (
  id              serial primary key,
  bdl_game_id     integer not null,
  bdl_batter_id   integer not null,
  stat_player_id  text,
  play_order      integer not null,
  play_text       text,
  inning          integer,
  detected_at     timestamptz not null default now(),
  unique (bdl_game_id, play_order)
);
create index if not exists bdl_hr_events_date_idx on public.bdl_hr_events(detected_at);
create index if not exists bdl_hr_events_player_idx on public.bdl_hr_events(stat_player_id);

-- ─── Extend user_settings for sportsbook + notifications ────────────
alter table public.user_settings
  add column if not exists default_sportsbook text not null default 'draftkings';
alter table public.user_settings
  add column if not exists hr_notifications boolean not null default true;
alter table public.user_settings
  add column if not exists hr_notifications_league boolean not null default false;
alter table public.user_settings
  add column if not exists waiver_accepted_at timestamptz;

-- ─── Add hit tracking to daily picks (safe if table doesn't exist yet) ──
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'user_daily_picks') then
    alter table public.user_daily_picks add column if not exists hit boolean;
  end if;
end $$;

-- ─── RLS ─────────────────────────────────────────────────────────────
alter table public.bdl_players      enable row level security;
alter table public.bdl_games        enable row level security;
alter table public.bdl_season_stats enable row level security;
alter table public.bdl_matchups     enable row level security;
alter table public.bdl_player_props enable row level security;
alter table public.bdl_hr_events    enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='bdl_players' and policyname='bdl_players_select') then
    create policy bdl_players_select on public.bdl_players for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='bdl_games' and policyname='bdl_games_select') then
    create policy bdl_games_select on public.bdl_games for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='bdl_season_stats' and policyname='bdl_season_stats_select') then
    create policy bdl_season_stats_select on public.bdl_season_stats for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='bdl_matchups' and policyname='bdl_matchups_select') then
    create policy bdl_matchups_select on public.bdl_matchups for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='bdl_player_props' and policyname='bdl_player_props_select') then
    create policy bdl_player_props_select on public.bdl_player_props for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='bdl_hr_events' and policyname='bdl_hr_events_select') then
    create policy bdl_hr_events_select on public.bdl_hr_events for select using (true);
  end if;
end $$;
