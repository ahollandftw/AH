import type { SupabaseClient } from '@supabase/supabase-js'

export type ScheduleGame = {
  gameId: string
  date: string
  homeTeam: string
  awayTeam: string
  slateType: string | null
  gamesOnDate: number | null
  /** First pitch UTC: BDL when present, else schedule CSV `start_time_utc` */
  startTimeUtc: string | null
  /** BallDontLie game id when this row is linked to API data; null for CSV-only rows */
  bdlGameId: number | null
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

function shiftIsoDate(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
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
  // Schedule CSV (`schedule_games`) is the source of truth for WHICH games exist on a date.
  // BDL (`bdl_games`) enriches: numeric game id, live status, scores, start_time when present.
  const [bdlRes, schedRes] = await Promise.all([
    supabase
      .from('bdl_games')
      .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev')
      .gte('date', shiftIsoDate(dateIso, -1))
      .lte('date', shiftIsoDate(dateIso, 1))
      .order('bdl_game_id'),
    supabase
      .from('schedule_games')
      .select('game_id,date,home_team,away_team,slate_type,games_on_date,start_time_utc')
      .eq('date', dateIso)
      .order('game_id'),
  ])

  const schedRows = (schedRes.data ?? []) as any[]

  const bdlByPair = new Map<string, any>()
  for (const r of (bdlRes.data ?? []) as any[]) {
    const utc: string | null = r.start_time_utc ?? null
    const etDate = utc ? utcToETDateIso(utc) : null
    if (utc && etDate && etDate !== dateIso) continue
    const rowDate = String(r.date ?? '').slice(0, 10)
    if (!utc && rowDate !== dateIso) continue
    const key = teamPairKey(r.home_team_abbrev, r.away_team_abbrev)
    const prev = bdlByPair.get(key)
    if (!prev) bdlByPair.set(key, r)
    else {
      const curMatch = rowDate === dateIso
      const prevMatch = String(prev.date ?? '').slice(0, 10) === dateIso
      if (curMatch && !prevMatch) bdlByPair.set(key, r)
    }
  }

  const schedByPair = new Map<string, { start_time_utc: string | null }>()
  for (const r of schedRows) {
    schedByPair.set(teamPairKey(r.home_team, r.away_team), {
      start_time_utc: r.start_time_utc != null ? String(r.start_time_utc) : null,
    })
  }

  const merged: ScheduleGame[] = []

  for (const r of schedRows) {
    const key = teamPairKey(r.home_team, r.away_team)
    const bdl = bdlByPair.get(key) ?? null
    const utc = bdl?.start_time_utc ?? null
    const schedStart = schedByPair.get(key)?.start_time_utc ?? null
    const startTimeUtc = (utc ?? schedStart) || null
    const bdlId = bdl?.bdl_game_id != null ? Number(bdl.bdl_game_id) : null
    const dateStr = typeof r.date === 'string' ? r.date.slice(0, 10) : dateIso
    const safeBdl =
      bdlId != null && Number.isFinite(bdlId) && bdlId > 0 ? bdlId : null
    merged.push({
      gameId: safeBdl != null ? String(safeBdl) : String(r.game_id),
      date: dateStr,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      slateType: r.slate_type ?? null,
      gamesOnDate: r.games_on_date ?? null,
      startTimeUtc,
      bdlGameId: safeBdl,
    })
  }

  const coveredPairs = new Set(merged.map((g) => teamPairKey(g.homeTeam, g.awayTeam)))

  for (const r of (bdlRes.data ?? []) as any[]) {
    const key = teamPairKey(r.home_team_abbrev, r.away_team_abbrev)
    if (coveredPairs.has(key)) continue
    const utc: string | null = r.start_time_utc ?? null
    const etDate = utc ? utcToETDateIso(utc) : null
    if (utc && etDate && etDate !== dateIso) continue
    if (!utc && String(r.date ?? '').slice(0, 10) !== dateIso) continue
    coveredPairs.add(key)
    const bid = Number(r.bdl_game_id)
    merged.push({
      gameId: String(r.bdl_game_id),
      date: etDate ?? String(r.date ?? '').slice(0, 10),
      homeTeam: r.home_team_abbrev,
      awayTeam: r.away_team_abbrev,
      slateType: null,
      gamesOnDate: merged.length || null,
      startTimeUtc: utc,
      bdlGameId: Number.isFinite(bid) && bid > 0 ? bid : null,
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
