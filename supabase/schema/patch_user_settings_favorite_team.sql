alter table public.user_settings
  add column if not exists favorite_team text;

-- Optional lightweight validation for MLB abbreviations (allows null).
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_settings_favorite_team_check'
  ) then
    alter table public.user_settings
      add constraint user_settings_favorite_team_check
      check (
        favorite_team is null or favorite_team in (
          'ARI','ATL','BAL','BOS','CHC','CHW','CIN','CLE','COL','DET','HOU','KCR','LAA','LAD',
          'MIA','MIL','MIN','NYM','NYY','ATH','PHI','PIT','SDP','SFG','SEA','STL','TBR','TEX','TOR','WSN'
        )
      );
  end if;
end $$;
