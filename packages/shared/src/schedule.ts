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

/**
 * Canonical team abbreviation — collapses known aliases so the same franchise
 * isn't counted twice (e.g. the Athletics were "OAK" in the CSV schedule but
 * appear as "ATH" in the BDL feed after their relocation).
 */
const TEAM_CANON: Record<string, string> = {
  OAK: 'ATH',
  TB: 'TBR',
  WAS: 'WSN', WSH: 'WSN',
  AZ: 'ARI',
  KC: 'KCR',
  SF: 'SFG',
  SD: 'SDP',
  CWS: 'CHW',
  LAA: 'LAA',
}
function canonTeam(t: string): string {
  const u = t.toUpperCase()
  return TEAM_CANON[u] ?? u
}

/** Stable pair key for deduplication (order-independent, alias-normalised). */
function teamPairKey(a: string, b: string): string {
  return [canonTeam(a), canonTeam(b)].sort().join('|')
}

export async function getGamesForDate(
  supabase: SupabaseClient,
  dateIso: string,
): Promise<ScheduleGame[]> {
  // Fetch both sources in parallel so we can merge them.
  // BDL has live scores/status, schedule_games has the full slate from the CSV.
  // We prefer BDL rows when a matchup exists in both, and supplement with
  // schedule_games for any matchups not yet synced to bdl_games.
  const [bdlRes, schedRes] = await Promise.all([
    supabase
      .from('bdl_games')
      .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev')
      .eq('date', dateIso)
      .order('bdl_game_id'),
    supabase
      .from('schedule_games')
      .select('game_id,date,home_team,away_team,slate_type,games_on_date')
      .eq('date', dateIso)
      .order('game_id'),
  ])

  const merged: ScheduleGame[] = []
  const coveredPairs = new Set<string>()

  // Add validated BDL games first (ET date check guards against sync-day bleed-over)
  for (const r of ((bdlRes.data ?? []) as any[])) {
    const utc: string | null = r.start_time_utc ?? null
    if (utc) {
      const etDate = utcToETDateIso(utc)
      if (etDate && etDate !== dateIso) continue // wrong calendar day — skip
    }
    const key = teamPairKey(r.home_team_abbrev, r.away_team_abbrev)
    coveredPairs.add(key)
    merged.push({
      gameId: String(r.bdl_game_id),
      date: r.date,
      homeTeam: r.home_team_abbrev,
      awayTeam: r.away_team_abbrev,
      slateType: null,
      gamesOnDate: 0, // filled in below
    })
  }

  // Supplement with schedule_games for matchups not yet in bdl_games
  for (const r of ((schedRes.data ?? []) as any[])) {
    const key = teamPairKey(r.home_team, r.away_team)
    if (coveredPairs.has(key)) continue // BDL already covers this matchup
    coveredPairs.add(key)
    merged.push({
      gameId: r.game_id,
      date: r.date,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      slateType: r.slate_type ?? null,
      gamesOnDate: r.games_on_date ?? null,
    })
  }

  const n = merged.length
  return merged.map((g) => ({ ...g, gamesOnDate: g.gamesOnDate || n }))
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
