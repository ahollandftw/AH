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

/** Sorted YYYY-MM-DD values that exist in schedule_games. */
export async function getScheduleDates(
  supabase: SupabaseClient,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('schedule_games')
    .select('date')
    .order('date', { ascending: true })

  if (error || !data?.length) return []
  const out = new Set<string>()
  for (const r of data as { date: string }[]) out.add(r.date)
  return [...out]
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
