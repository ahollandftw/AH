-- Run in Supabase SQL Editor after projections.sql (or on existing DBs).
-- Enables caching default + weighted_pitch_arsenal + contact_quality in one table.

alter table public.daily_hr_projections
  add column if not exists model_variant text not null default 'default';

alter table public.daily_hr_projections
  drop constraint if exists daily_hr_projections_date_player_id_key;

-- Replace with composite unique (date, player_id, model_variant)
create unique index if not exists daily_hr_projections_date_player_model_uidx
  on public.daily_hr_projections (date, player_id, model_variant);

alter table public.daily_hr_projections
  drop constraint if exists daily_hr_projections_model_variant_check;

alter table public.daily_hr_projections
  add constraint daily_hr_projections_model_variant_check
  check (model_variant in ('default', 'weighted_pitch_arsenal', 'contact_quality'));
