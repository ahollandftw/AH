create table if not exists public.game_weather_cache (
  bdl_game_id integer primary key references public.bdl_games (bdl_game_id) on delete cascade,
  game_date date not null,
  home_team text not null,
  away_team text not null,
  stadium text,
  lat numeric,
  lon numeric,
  game_start_utc timestamptz,
  snapshot_time_utc timestamptz,
  temp_f numeric,
  humidity_pct numeric,
  wind_speed_mph numeric,
  wind_deg numeric,
  weather_main text,
  weather_description text,
  source text not null default 'openweather_hourly',
  payload jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now()
);

create index if not exists game_weather_cache_date_idx
  on public.game_weather_cache (game_date);

create index if not exists game_weather_cache_home_team_idx
  on public.game_weather_cache (home_team, game_date);

alter table public.game_weather_cache enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where tablename = 'game_weather_cache'
      and policyname = 'game_weather_cache_select'
  ) then
    create policy game_weather_cache_select
      on public.game_weather_cache
      for select
      using (true);
  end if;
end $$;
