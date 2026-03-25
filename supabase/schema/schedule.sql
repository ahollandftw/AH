-- MLB schedule table. Populated via import-stat-csv.mjs from data/mlb_2026_schedule.csv.

create table if not exists public.schedule_games (
  game_id    text primary key,
  slate_id   text,
  date       date not null,
  day_of_week text,
  slate_type text,
  games_on_date int,
  home_team  text not null,
  away_team  text not null,
  home_league text,
  away_league text,
  interleague boolean default false,
  neutral_site boolean default false,
  doubleheader boolean default false
);

create index if not exists idx_schedule_games_date on public.schedule_games (date);
create index if not exists idx_schedule_games_home on public.schedule_games (home_team);
create index if not exists idx_schedule_games_away on public.schedule_games (away_team);

alter table public.schedule_games enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'schedule_games'
      and policyname = 'schedule_games_public_select'
  ) then
    create policy schedule_games_public_select
    on public.schedule_games for select using (true);
  end if;
end $$;
