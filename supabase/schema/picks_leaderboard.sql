-- Daily picks + public leaderboard for AnalyticHustle.
-- Run after watchlist.sql + social_profiles.sql + subscriptions.sql.

alter table public.user_subscriptions
  add column if not exists plan_tier text not null default 'free',
  add column if not exists billing_cycle text not null default 'monthly',
  add column if not exists has_plus boolean not null default false;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_subscriptions_plan_tier_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_plan_tier_check
      check (plan_tier in ('free', 'basic', 'plus'));
  end if;

  if exists (
    select 1
    from pg_constraint
    where conname = 'user_subscriptions_billing_cycle_check'
  ) then
    alter table public.user_subscriptions
      drop constraint user_subscriptions_billing_cycle_check;
  end if;

  alter table public.user_subscriptions
    add constraint user_subscriptions_billing_cycle_check
    check (billing_cycle in ('monthly'));
end $$;

create table if not exists public.user_daily_picks (
  user_id uuid not null references auth.users(id) on delete cascade,
  pick_date date not null default current_date,
  player_id text not null references public.players(stat_player_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, pick_date, player_id)
);

create index if not exists idx_user_daily_picks_date on public.user_daily_picks (pick_date);
create index if not exists idx_user_daily_picks_user on public.user_daily_picks (user_id);

alter table public.user_daily_picks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_daily_picks' and policyname = 'user_daily_picks_select_own'
  ) then
    create policy user_daily_picks_select_own
    on public.user_daily_picks
    for select
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_daily_picks' and policyname = 'user_daily_picks_insert_own'
  ) then
    create policy user_daily_picks_insert_own
    on public.user_daily_picks
    for insert
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_daily_picks' and policyname = 'user_daily_picks_delete_own'
  ) then
    create policy user_daily_picks_delete_own
    on public.user_daily_picks
    for delete
    using (auth.uid() = user_id);
  end if;
end $$;

create or replace function public.enforce_daily_pick_limit()
returns trigger
language plpgsql
as $$
declare
  current_count integer;
begin
  select count(*)::int into current_count
  from public.user_daily_picks
  where user_id = new.user_id
    and pick_date = new.pick_date;

  if current_count >= 3 then
    raise exception 'Max 3 picks per day';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_daily_pick_limit on public.user_daily_picks;
create trigger trg_enforce_daily_pick_limit
before insert on public.user_daily_picks
for each row execute function public.enforce_daily_pick_limit();

create or replace function public.user_pick_leaderboard(limit_rows integer default 100)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  hits bigint,
  total_picks bigint,
  hit_pct numeric
)
language sql
security definer
set search_path = public
as $$
  select
    au.id as user_id,
    coalesce(nullif(us.display_name, ''), split_part(au.email, '@', 1)) as display_name,
    us.avatar_url,
    coalesce(sum(case when coalesce(psd.home_runs, 0) > 0 then 1 else 0 end), 0)::bigint as hits,
    count(udp.player_id)::bigint as total_picks,
    case
      when count(udp.player_id) = 0 then 0::numeric
      else round(
        (coalesce(sum(case when coalesce(psd.home_runs, 0) > 0 then 1 else 0 end), 0)::numeric / count(udp.player_id)::numeric) * 100,
        2
      )
    end as hit_pct
  from auth.users au
  left join public.user_settings us on us.user_id = au.id
  left join public.user_daily_picks udp on udp.user_id = au.id
  left join public.player_stats_daily psd
    on psd.player_id::text = udp.player_id
   and psd.date = udp.pick_date
  group by au.id, us.display_name, us.avatar_url, au.email
  order by hit_pct desc, total_picks desc,
    coalesce(nullif(us.display_name, ''), split_part(au.email, '@', 1)) asc
  limit greatest(coalesce(limit_rows, 100), 1);
$$;

grant execute on function public.user_pick_leaderboard(integer) to anon, authenticated;

create or replace function public.user_profile_picks_for_date(target_user_id uuid, target_date date default current_date)
returns table (
  player_id text,
  player_name text,
  team text,
  was_hit boolean
)
language sql
security definer
set search_path = public
as $$
  with allowed as (
    select 1
    where exists (select 1 from auth.users au where au.id = target_user_id)
      and (
        auth.uid() = target_user_id
        or exists (
          select 1
          from public.user_settings us
          where us.user_id = target_user_id
            and (
              us.profile_visibility = 'public'
              or (
                us.profile_visibility = 'friends'
                and exists (
                  select 1
                  from public.user_friendships f
                  where f.status = 'accepted'
                    and (
                      (f.user_id = auth.uid() and f.friend_user_id = target_user_id)
                      or (f.friend_user_id = auth.uid() and f.user_id = target_user_id)
                    )
                )
              )
            )
        )
      )
  )
  select
    udp.player_id,
    p.name as player_name,
    p.team,
    coalesce(psd.home_runs, 0) > 0 as was_hit
  from allowed
  join public.user_daily_picks udp
    on udp.user_id = target_user_id
   and udp.pick_date = target_date
  join public.players p
    on p.stat_player_id = udp.player_id
  left join public.player_stats_daily psd
    on psd.player_id::text = udp.player_id
   and psd.date = udp.pick_date
  order by p.name;
$$;

grant execute on function public.user_profile_picks_for_date(uuid, date) to anon, authenticated;
