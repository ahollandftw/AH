-- Optional first-pitch time from schedule CSV (ISO-8601, e.g. 2026-04-07T02:05:00+00:00).
-- Used as fallback when BallDontLie bdl_games.start_time_utc is null.

alter table public.schedule_games
  add column if not exists start_time_utc timestamptz;

comment on column public.schedule_games.start_time_utc is
  'First pitch UTC; optional, from mlb_*_schedule.csv column start_time_utc';
