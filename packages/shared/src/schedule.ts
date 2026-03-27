import type { SupabaseClient } from '@supabase/supabase-js'

export type ScheduleGame = {
  gameId: string
  date: string
  homeTeam: string
  awayTeam: string
  slateType: string | null
  gamesOnDate: number | null
}

export async function getGamesForDate(
  supabase: SupabaseClient,
  dateIso: string,
): Promise<ScheduleGame[]> {
  // Prefer BallDontLie-synced rows so each date matches the live API slate (CSV schedule can drift).
  const { data: bdl, error: bdlErr } = await supabase
    .from('bdl_games')
    .select('bdl_game_id,date,home_team_abbrev,away_team_abbrev')
    .eq('date', dateIso)
    .order('bdl_game_id')

  if (!bdlErr && bdl?.length) {
    const n = bdl.length
    return (bdl as any[]).map((r) => ({
      gameId: String(r.bdl_game_id),
      date: r.date,
      homeTeam: r.home_team_abbrev,
      awayTeam: r.away_team_abbrev,
      slateType: null,
      gamesOnDate: n,
    }))
  }

  const { data, error } = await supabase
    .from('schedule_games')
    .select('game_id,date,home_team,away_team,slate_type,games_on_date')
    .eq('date', dateIso)
    .order('game_id')

  if (error || !data?.length) return []
  return data.map((r: any) => ({
    gameId: r.game_id,
    date: r.date,
    homeTeam: r.home_team,
    awayTeam: r.away_team,
    slateType: r.slate_type ?? null,
    gamesOnDate: r.games_on_date ?? null,
  }))
}

/** Sorted YYYY-MM-DD values that exist in synced games or the static schedule. */
export async function getScheduleDates(
  supabase: SupabaseClient,
): Promise<string[]> {
  const out = new Set<string>()
  const [{ data: bdlDates, error: bdlErr }, { data: schedDates, error: schedErr }] =
    await Promise.all([
      supabase.from('bdl_games').select('date').order('date', { ascending: true }),
      supabase.from('schedule_games').select('date').order('date', { ascending: true }),
    ])
  if (!bdlErr && bdlDates?.length) {
    for (const r of bdlDates as { date: string }[]) out.add(r.date)
  }
  if (!schedErr && schedDates?.length) {
    for (const r of schedDates as { date: string }[]) out.add(r.date)
  }
  return [...out].sort()
}

/**
 * All unique team abbreviations playing on a given date (home + away).
 */
export async function getTeamsPlayingOn(
  supabase: SupabaseClient,
  dateIso: string,
): Promise<string[]> {
  const games = await getGamesForDate(supabase, dateIso)
  const set = new Set<string>()
  for (const g of games) {
    set.add(g.homeTeam)
    set.add(g.awayTeam)
  }
  return [...set].sort()
}
