-- Helpers for server-side Expo push (Edge Functions + service_role only).
-- Run after push_tokens.sql and watchlist.sql.

-- All users with alerts on and at least one device token.
create or replace function public.get_expo_push_tokens_broadcast()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct upt.expo_push_token::text
  from public.user_push_tokens upt
  inner join public.user_settings us on us.user_id = upt.user_id
  where us.global_alerts_enabled = true;
$$;

-- Users watching this Statcast player id, alerts on, with a device token.
-- DROP required when upgrading from the old version whose parameter was named p_slug (Postgres disallows renaming params via OR REPLACE).
drop function if exists public.get_expo_push_tokens_for_watchlist_player(text);

create or replace function public.get_expo_push_tokens_for_watchlist_player(p_stat_player_id text)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct upt.expo_push_token::text
  from public.user_push_tokens upt
  inner join public.user_settings us on us.user_id = upt.user_id
  inner join public.watchlist_players wp on wp.user_id = upt.user_id
  where us.global_alerts_enabled = true
  and wp.player_id = p_stat_player_id;
$$;

-- Backwards compatibility: older Edge payloads used player slug.
create or replace function public.get_expo_push_tokens_for_watchlist_player_by_slug(p_slug text)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct upt.expo_push_token::text
  from public.user_push_tokens upt
  inner join public.user_settings us on us.user_id = upt.user_id
  inner join public.watchlist_players wp on wp.user_id = upt.user_id
  inner join public.players p on p.stat_player_id = wp.player_id
  where us.global_alerts_enabled = true
  and p.slug = p_slug;
$$;

revoke all on function public.get_expo_push_tokens_broadcast() from public;
revoke all on function public.get_expo_push_tokens_for_watchlist_player(text) from public;
revoke all on function public.get_expo_push_tokens_for_watchlist_player_by_slug(text) from public;
grant execute on function public.get_expo_push_tokens_broadcast() to service_role;
grant execute on function public.get_expo_push_tokens_for_watchlist_player(text) to service_role;
grant execute on function public.get_expo_push_tokens_for_watchlist_player_by_slug(text) to service_role;
