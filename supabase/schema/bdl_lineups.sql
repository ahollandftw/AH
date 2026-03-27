-- Cached BDL lineups for projected + confirmed lineup display.
-- Stores each batter's lineup position per game. Yesterday's lineup is used
-- as a projected lineup for today until official lineups are posted ~1hr pre-game.

create table if not exists public.bdl_lineups (
  id              serial primary key,
  bdl_game_id     integer not null,
  date            date not null,
  team_abbrev     text not null,
  side            text not null check (side in ('home', 'away')),
  bdl_player_id   integer,
  stat_player_id  text,
  full_name       text,
  position        text,
  batting_order   integer,
  is_confirmed    boolean not null default false,
  fetched_at      timestamptz not null default now(),
  unique (bdl_game_id, bdl_player_id, side)
);

create index if not exists bdl_lineups_date_idx on public.bdl_lineups(date);
create index if not exists bdl_lineups_team_idx on public.bdl_lineups(team_abbrev);
create index if not exists bdl_lineups_game_idx on public.bdl_lineups(bdl_game_id);

alter table public.bdl_lineups enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='bdl_lineups' and policyname='bdl_lineups_select') then
    create policy bdl_lineups_select on public.bdl_lineups for select using (true);
  end if;
end $$;
