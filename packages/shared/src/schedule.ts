import type { SupabaseClient } from '@supabase/supabase-js'

export type ScheduleGame = {
  gameId: string
  date: string
  homeTeam: string
  awayTeam: string
  slateType: string | null
  gamesOnDate: number | null
}

/**
 * Derive the Eastern Time calendar date from a UTC timestamp.
 * A late West Coast game (e.g. 7 PM PT = 10 PM ET on 3/26) has a start_time_utc
 * that falls on 3/27 UTC — but it belongs on the 3/26 slate in ET.
 */
function utcToETDateIso(utcStr: string): string | null {
  try {
    const d = new Date(new Date(utcStr).toLocaleString('en-US', { timeZone: 'America/New_York' }))
    if (isNaN(d.getTime())) return null
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${dd}`
  } catch {
    return null
  }
}

export async function getGamesForDate(
  supabase: SupabaseClient,
  dateIso: string,
): Promise<ScheduleGame[]> {
  // Prefer BallDontLie-synced rows so each date matches the live API slate (CSV schedule can drift).
  const { data: bdl, error: bdlErr } = await supabase
    .from('bdl_games')
    .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev')
    .eq('date', dateIso)
    .order('bdl_game_id')

  if (!bdlErr && bdl?.length) {
    // Guard against rows whose `date` was stored incorrectly (e.g. sync ran on 3/27 and
    // overwrote a 3/26 game's date). Validate against start_time_utc in ET when present.
    const valid = (bdl as any[]).filter((r) => {
      const utc: string | null = r.start_time_utc ?? null
      if (!utc) return true // no time info — trust the stored date
      const etDate = utcToETDateIso(utc)
      return etDate == null || etDate === dateIso
    })
    if (valid.length) {
      const n = valid.length
      return valid.map((r) => ({
        gameId: String(r.bdl_game_id),
        date: r.date,
        homeTeam: r.home_team_abbrev,
        awayTeam: r.away_team_abbrev,
        slateType: null,
        gamesOnDate: n,
      }))
    }
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
