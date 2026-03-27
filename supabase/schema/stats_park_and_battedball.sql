-- Park factors (team/venue, no player id) + batted-ball profiles by player (Statcast player_id).
-- Apply after stats_csv_tables.sql. Import: npm run import:stats

-- PARKFACTORS2025.csv, parkfactorsleftyhitters.csv, parkfactorsrightyhitters.csv
-- Columns vary slightly; numeric extras live in metrics jsonb.
create table if not exists public.stats_park_factors (
  scope text not null check (scope in ('overall', 'lefty_hitters', 'righty_hitters')),
  rk int,
  team text,
  venue text not null,
  year_label text not null,
  park_factor int,
  metrics jsonb not null default '{}'::jsonb,
  primary key (scope, venue, year_label)
);

create index if not exists stats_park_factors_scope_idx on public.stats_park_factors (scope);

-- b.battedballvLHP / vRHP, p.battedballvLHH / vRHH (2019–2025 aggregates)
create table if not exists public.stats_batted_ball (
  role text not null check (role in ('batting', 'pitching')),
  split text not null check (split in ('vs_lhp', 'vs_rhp', 'vs_lhh', 'vs_rhh')),
  player_id text not null references public.players (stat_player_id) on delete cascade,
  player_name text,
  team text,
  mlbam_id bigint,
  metrics jsonb not null default '{}'::jsonb,
  primary key (role, split, player_id)
);

create index if not exists stats_batted_ball_player_idx on public.stats_batted_ball (player_id);

alter table public.stats_park_factors enable row level security;
alter table public.stats_batted_ball enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stats_park_factors' and policyname = 'stats_park_factors_select') then
    create policy stats_park_factors_select on public.stats_park_factors for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stats_batted_ball' and policyname = 'stats_batted_ball_select') then
    create policy stats_batted_ball_select on public.stats_batted_ball for select using (true);
  end if;
end $$;
