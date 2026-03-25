-- Run this FIRST if you see: column "stat_player_id" of relation "players" does not exist.
-- Safe to re-run. Does not touch child tables (watchlist, projections, launch lab projections).
--
-- After this succeeds, run migrate_stat_player_id.sql to convert uuid player_id FKs to Statcast ids,
-- then re-run any seed inserts you need.

alter table public.players add column if not exists stat_player_id text;

update public.players set stat_player_id = '660271' where slug = 'shohei-ohtani' and (stat_player_id is null or stat_player_id = '');
update public.players set stat_player_id = '592450' where slug = 'aaron-judge' and (stat_player_id is null or stat_player_id = '');
update public.players set stat_player_id = 'legacy-' || id::text where stat_player_id is null;

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
