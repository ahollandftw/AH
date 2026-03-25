-- Migrate existing deployments that used uuid player_id to Statcast stat_player_id (text).
-- Run AFTER launch_lab.sql, projections.sql, watchlist.sql have been applied in the OLD form
-- (uuid FK to players.id). Safe to re-run: skips when already on stat ids.
--
-- New projects should use the updated launch_lab.sql / projections.sql / watchlist.sql directly
-- and do not need this file.

-- 1) players.stat_player_id: add, backfill, enforce uniqueness + NOT NULL
alter table public.players add column if not exists stat_player_id text;

update public.players set stat_player_id = '660271' where slug = 'shohei-ohtani' and (stat_player_id is null or stat_player_id = '');
update public.players set stat_player_id = '592450' where slug = 'aaron-judge' and (stat_player_id is null or stat_player_id = '');

update public.players
set stat_player_id = 'legacy-' || id::text
where stat_player_id is null or stat_player_id = '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'players_stat_player_id_key' and conrelid = 'public.players'::regclass
  ) then
    alter table public.players add constraint players_stat_player_id_key unique (stat_player_id);
  end if;
end $$;

alter table public.players alter column stat_player_id set not null;

-- 2) daily_hr_projections
do $$
declare
  dt text;
begin
  select c.data_type into dt
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'daily_hr_projections'
    and c.column_name = 'player_id';

  if dt = 'uuid' then
    alter table public.daily_hr_projections drop constraint if exists daily_hr_projections_player_id_fkey;
    alter table public.daily_hr_projections drop constraint if exists daily_hr_projections_date_player_id_key;

    alter table public.daily_hr_projections add column if not exists player_stat_id text;

    update public.daily_hr_projections d
    set player_stat_id = p.stat_player_id
    from public.players p
    where p.id = d.player_id;

    alter table public.daily_hr_projections drop column player_id;
    alter table public.daily_hr_projections rename column player_stat_id to player_id;

    alter table public.daily_hr_projections
      add constraint daily_hr_projections_player_id_fkey
      foreign key (player_id) references public.players (stat_player_id) on delete cascade;

    create unique index if not exists daily_hr_projections_date_player_uidx
      on public.daily_hr_projections (date, player_id);
  end if;
end $$;

-- 3) player_launchlab_projections
do $$
declare
  dt text;
begin
  select c.data_type into dt
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'player_launchlab_projections'
    and c.column_name = 'player_id';

  if dt = 'uuid' then
    alter table public.player_launchlab_projections drop constraint if exists player_launchlab_projections_player_id_fkey;
    alter table public.player_launchlab_projections drop constraint if exists player_launchlab_projections_player_id_date_key;

    alter table public.player_launchlab_projections add column if not exists player_stat_id text;

    update public.player_launchlab_projections pl
    set player_stat_id = p.stat_player_id
    from public.players p
    where p.id = pl.player_id;

    alter table public.player_launchlab_projections drop column player_id;
    alter table public.player_launchlab_projections rename column player_stat_id to player_id;

    alter table public.player_launchlab_projections
      add constraint player_launchlab_projections_player_id_fkey
      foreign key (player_id) references public.players (stat_player_id) on delete cascade;

    create unique index if not exists player_launchlab_projections_player_date_uidx
      on public.player_launchlab_projections (player_id, date);
  end if;
end $$;

-- 4) watchlist_players
do $$
declare
  dt text;
begin
  select c.data_type into dt
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'watchlist_players'
    and c.column_name = 'player_id';

  if dt = 'uuid' then
    alter table public.watchlist_players drop constraint if exists watchlist_players_player_id_fkey;
    alter table public.watchlist_players drop constraint if exists watchlist_players_pkey;

    alter table public.watchlist_players add column if not exists player_stat_id text;

    update public.watchlist_players w
    set player_stat_id = p.stat_player_id
    from public.players p
    where p.id = w.player_id;

    alter table public.watchlist_players drop column player_id;
    alter table public.watchlist_players rename column player_stat_id to player_id;

    alter table public.watchlist_players add primary key (user_id, player_id);

    alter table public.watchlist_players
      add constraint watchlist_players_player_id_fkey
      foreign key (player_id) references public.players (stat_player_id) on delete cascade;
  end if;
end $$;
