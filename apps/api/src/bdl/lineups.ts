import type { SupabaseClient } from '@supabase/supabase-js'
import { bdlFetch, bdlFetchAll } from './client.js'

export type TeamLineupPlayer = {
  bdl_player_id: number | null
  stat_player_id: string | null
  full_name: string | null
  position: string | null
  batting_order: number | null
}

export type TeamPitcherInfo = {
  bdl_player_id: number | null
  stat_player_id: string | null
  full_name: string | null
  position: string | null
}

export type TeamLineupSource = 'official' | 'previous_game' | 'none'

export type GameLineupResult = {
  game_id: number | null
  home: TeamLineupPlayer[]
  away: TeamLineupPlayer[]
  home_pitcher: TeamPitcherInfo | null
  away_pitcher: TeamPitcherInfo | null
  home_source: TeamLineupSource
  away_source: TeamLineupSource
}

type BdlGameRow = {
  bdl_game_id: number
  date: string
  start_time_utc: string | null
  home_team_abbrev: string
  away_team_abbrev: string
}

type RawLineupEntry = {
  game_id?: number | null
  team?: {
    abbreviation?: string
  } | null
  player?: {
    id?: number
    full_name?: string
    first_name?: string
    last_name?: string
    position?: string
  } | null
  player_id?: number
  full_name?: string
  batting_order?: number | null
  position?: string | null
  is_probable_pitcher?: boolean | null
}

type PlayerXref = {
  stat_player_id: string | null
  full_name: string | null
}

const TEAM_ALIASES: Record<string, string> = {
  AZ: 'ARI',
  ARI: 'ARI',
  WSH: 'WSN',
  WAS: 'WSN',
  WSN: 'WSN',
  CWS: 'CHW',
  CHW: 'CHW',
  KC: 'KCR',
  KCR: 'KCR',
  SF: 'SFG',
  SFG: 'SFG',
  SD: 'SDP',
  SDP: 'SDP',
  TB: 'TBR',
  TBR: 'TBR',
  OAK: 'ATH',
  ATH: 'ATH',
}

function canonTeam(team: string | null | undefined): string | null {
  if (!team) return null
  const key = team.trim().toUpperCase()
  return TEAM_ALIASES[key] ?? key
}

/** Order-independent key so CSV home/away matches BDL abbrev aliases. */
function teamPairKey(a: string, b: string): string {
  const ca = canonTeam(a) ?? a.trim().toUpperCase()
  const cb = canonTeam(b) ?? b.trim().toUpperCase()
  return [ca, cb].sort().join('|')
}

function shiftIsoDate(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function utcToETDateIso(utcStr: string | null | undefined): string | null {
  if (!utcStr) return null
  try {
    const d = new Date(new Date(utcStr).toLocaleString('en-US', { timeZone: 'America/New_York' }))
    if (Number.isNaN(d.getTime())) return null
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${dd}`
  } catch {
    return null
  }
}

function orderValue(v: number | null | undefined): number {
  if (v == null || v <= 0) return Number.MAX_SAFE_INTEGER
  return v
}

function batterCount(rows: TeamLineupPlayer[]): number {
  return rows.filter((r) => r.batting_order != null && r.batting_order > 0).length
}

function fullNameFromEntry(entry: RawLineupEntry): string | null {
  if (entry.player?.full_name) return entry.player.full_name
  if (entry.full_name) return entry.full_name
  const first = entry.player?.first_name?.trim() ?? ''
  const last = entry.player?.last_name?.trim() ?? ''
  const full = `${first} ${last}`.trim()
  return full || null
}

async function fetchGamesAroundDate(
  sb: SupabaseClient,
  dateIso: string,
): Promise<BdlGameRow[]> {
  const prev = shiftIsoDate(dateIso, -1)
  const next = shiftIsoDate(dateIso, 1)
  const { data } = await sb
    .from('bdl_games')
    .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev')
    .gte('date', prev)
    .lte('date', next)
    .order('start_time_utc', { ascending: true })

  return ((data ?? []) as BdlGameRow[]).filter((g) => {
    const etDate = utcToETDateIso(g.start_time_utc)
    return etDate ? etDate === dateIso : g.date === dateIso
  })
}

async function resolveGameForMatchup(
  sb: SupabaseClient,
  args: { dateIso: string; gameId?: number | null; homeTeam: string; awayTeam: string },
): Promise<BdlGameRow | null> {
  if (args.gameId) {
    const { data } = await sb
      .from('bdl_games')
      .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev')
      .eq('bdl_game_id', args.gameId)
      .maybeSingle()
    if (data) return data as BdlGameRow
  }

  const targetHome = canonTeam(args.homeTeam)
  const targetAway = canonTeam(args.awayTeam)
  const rows = await fetchGamesAroundDate(sb, args.dateIso)
  return (
    rows.find((g) => {
      const home = canonTeam(g.home_team_abbrev)
      const away = canonTeam(g.away_team_abbrev)
      return home === targetHome && away === targetAway
    }) ?? null
  )
}

async function fetchLineupXref(
  sb: SupabaseClient,
  entries: RawLineupEntry[],
): Promise<Map<number, PlayerXref>> {
  const allIds = [
    ...new Set(
      entries
        .map((e) => Number(e.player?.id ?? e.player_id ?? 0))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ]

  const { data: xref } = allIds.length
    ? await sb.from('bdl_players').select('bdl_id,stat_player_id,full_name').in('bdl_id', allIds)
    : { data: [] as Array<{ bdl_id: number; stat_player_id: string | null; full_name: string | null }> }

  return new Map<number, PlayerXref>(
    (xref ?? []).map((r: any) => [
      Number(r.bdl_id),
      { stat_player_id: r.stat_player_id ?? null, full_name: r.full_name ?? null },
    ]),
  )
}

function mapRawLineupEntries(
  entries: RawLineupEntry[],
  xrefMap: Map<number, PlayerXref>,
): TeamLineupPlayer[] {
  return entries
    .map((e) => {
      const bdlId = Number(e.player?.id ?? e.player_id ?? 0) || null
      const xr = bdlId ? xrefMap.get(bdlId) : null
      return {
        bdl_player_id: bdlId,
        stat_player_id: xr?.stat_player_id ?? null,
        full_name: fullNameFromEntry(e) ?? xr?.full_name ?? null,
        position: e.position ?? e.player?.position ?? null,
        batting_order: e.batting_order ?? null,
      }
    })
    .sort((a, b) => orderValue(a.batting_order) - orderValue(b.batting_order))
}

function firstPitcher(rows: TeamLineupPlayer[]): TeamPitcherInfo | null {
  const pitcher =
    rows.find((r) => String(r.position ?? '').toUpperCase() === 'P') ??
    rows.find((r) => r.batting_order == null)
  if (!pitcher) return null
  return {
    bdl_player_id: pitcher.bdl_player_id,
    stat_player_id: pitcher.stat_player_id,
    full_name: pitcher.full_name,
    position: pitcher.position,
  }
}

async function mapRawLineup(
  sb: SupabaseClient,
  entries: RawLineupEntry[],
): Promise<TeamLineupPlayer[]> {
  const xrefMap = await fetchLineupXref(sb, entries)
  return mapRawLineupEntries(entries, xrefMap)
}

function parseOfficialLineupRows(
  game: BdlGameRow,
  rows: RawLineupEntry[],
  xrefMap: Map<number, PlayerXref>,
): { home: TeamLineupPlayer[]; away: TeamLineupPlayer[] } | null {
  const homeAbbrev = canonTeam(game.home_team_abbrev)
  const awayAbbrev = canonTeam(game.away_team_abbrev)
  const homeRaw = rows.filter((r) => canonTeam(r.team?.abbreviation) === homeAbbrev)
  const awayRaw = rows.filter((r) => canonTeam(r.team?.abbreviation) === awayAbbrev)
  if (!homeRaw.length && !awayRaw.length) return null

  return {
    home: mapRawLineupEntries(homeRaw, xrefMap),
    away: mapRawLineupEntries(awayRaw, xrefMap),
  }
}

async function fetchOfficialLineupsForGames(
  sb: SupabaseClient,
  games: BdlGameRow[],
): Promise<Map<number, { home: TeamLineupPlayer[]; away: TeamLineupPlayer[] } | null>> {
  const out = new Map<number, { home: TeamLineupPlayer[]; away: TeamLineupPlayer[] } | null>()
  if (!games.length) return out

  try {
    const rows = await bdlFetchAll<RawLineupEntry>('/mlb/v1/lineups')
    const validGameIds = new Set(games.map((g) => g.bdl_game_id))
    const scopedRows = rows.filter((r) => validGameIds.has(Number(r.game_id ?? 0)))
    const xrefMap = await fetchLineupXref(sb, scopedRows)
    for (const game of games) {
      const gameRows = scopedRows.filter((r) => Number(r.game_id ?? 0) === game.bdl_game_id)
      out.set(game.bdl_game_id, parseOfficialLineupRows(game, gameRows, xrefMap))
    }
  } catch {
    for (const game of games) out.set(game.bdl_game_id, null)
  }

  return out
}

async function fetchOfficialGameLineup(
  sb: SupabaseClient,
  game: BdlGameRow,
): Promise<{ home: TeamLineupPlayer[]; away: TeamLineupPlayer[] } | null> {
  try {
    const officialMap = await fetchOfficialLineupsForGames(sb, [game])
    const bulkLineup = officialMap.get(game.bdl_game_id) ?? null
    if (!bulkLineup) {
      const res = await bdlFetch<{
        data?: {
          home?: RawLineupEntry[]
          away?: RawLineupEntry[]
          home_lineup?: RawLineupEntry[]
          away_lineup?: RawLineupEntry[]
        }
      }>('/mlb/v1/lineups', { game_id: game.bdl_game_id })

      const payload = res.data ?? {}
      const homeRaw = payload.home_lineup ?? payload.home ?? []
      const awayRaw = payload.away_lineup ?? payload.away ?? []
      if (!homeRaw.length && !awayRaw.length) return null

      return {
        home: await mapRawLineup(sb, homeRaw),
        away: await mapRawLineup(sb, awayRaw),
      }
    }
    return bulkLineup
  } catch {
    return null
  }
}

async function findRecentTeamLineup(
  sb: SupabaseClient,
  team: string,
  beforeStartUtc?: string | null,
): Promise<TeamLineupPlayer[]> {
  const canonical = canonTeam(team)
  if (!canonical) return []

  let query = sb
    .from('bdl_games')
    .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev')
    .or(`home_team_abbrev.eq.${team},away_team_abbrev.eq.${team},home_team_abbrev.eq.${canonical},away_team_abbrev.eq.${canonical}`)
    .order('start_time_utc', { ascending: false })
    .limit(20)

  if (beforeStartUtc) {
    query = query.lt('start_time_utc', beforeStartUtc)
  }

  const { data } = await query
  const games = (data ?? []) as BdlGameRow[]

  for (const game of games) {
    const official = await fetchOfficialGameLineup(sb, game)
    if (!official) continue
    const isHome = canonTeam(game.home_team_abbrev) === canonical
    const sideRows = isHome ? official.home : official.away
    if (batterCount(sideRows) >= 9) return sideRows
  }

  return []
}

export async function getBestLineupForGame(
  sb: SupabaseClient,
  args: {
    dateIso: string
    homeTeam: string
    awayTeam: string
    gameId?: number | null
  },
): Promise<GameLineupResult> {
  const game = await resolveGameForMatchup(sb, args)
  const official = game?.bdl_game_id ? await fetchOfficialGameLineup(sb, game) : null

  const homeOfficial = official?.home ?? []
  const awayOfficial = official?.away ?? []

  const home =
    batterCount(homeOfficial) >= 9
      ? homeOfficial
      : await findRecentTeamLineup(sb, args.homeTeam, game?.start_time_utc ?? null)
  const away =
    batterCount(awayOfficial) >= 9
      ? awayOfficial
      : await findRecentTeamLineup(sb, args.awayTeam, game?.start_time_utc ?? null)

  return {
    game_id: game?.bdl_game_id ?? args.gameId ?? null,
    home,
    away,
    home_pitcher: firstPitcher(homeOfficial) ?? firstPitcher(home),
    away_pitcher: firstPitcher(awayOfficial) ?? firstPitcher(away),
    home_source: batterCount(homeOfficial) >= 9 ? 'official' : home.length ? 'previous_game' : 'none',
    away_source: batterCount(awayOfficial) >= 9 ? 'official' : away.length ? 'previous_game' : 'none',
  }
}

export async function getResolvedGamesForDate(
  sb: SupabaseClient,
  dateIso: string,
) {
  return fetchGamesAroundDate(sb, dateIso)
}

/** How long DB-cached lineups are considered fresh. */
const LINEUP_CACHE_TTL_MS = 3 * 60 * 60 * 1000 // 3 hours

/** Build a GameLineupResult from a raw bdl_lineup_cache row. */
function resultFromCacheRow(
  gameId: number,
  row: {
    home_lineup: unknown
    away_lineup: unknown
    home_pitcher: unknown
    away_pitcher: unknown
    home_source: unknown
    away_source: unknown
  },
): GameLineupResult {
  return {
    game_id: gameId,
    home: (row.home_lineup as TeamLineupPlayer[]) ?? [],
    away: (row.away_lineup as TeamLineupPlayer[]) ?? [],
    home_pitcher: (row.home_pitcher as TeamPitcherInfo | null) ?? null,
    away_pitcher: (row.away_pitcher as TeamPitcherInfo | null) ?? null,
    home_source: (row.home_source as TeamLineupSource) ?? 'none',
    away_source: (row.away_source as TeamLineupSource) ?? 'none',
  }
}

export async function getBestLineupsForDate(
  sb: SupabaseClient,
  dateIso: string,
): Promise<Record<string, GameLineupResult>> {
  const [games, schedRes] = await Promise.all([
    fetchGamesAroundDate(sb, dateIso),
    sb.from('schedule_games').select('game_id,home_team,away_team').eq('date', dateIso),
  ])
  const schedList = (schedRes.data ?? []) as Array<{ game_id: string; home_team: string; away_team: string }>

  const out: Record<string, GameLineupResult> = {}
  const bdlPairKeys = new Set(games.map((g) => teamPairKey(g.home_team_abbrev, g.away_team_abbrev)))

  if (games.length) {
    const gameIds = games.map((g) => g.bdl_game_id)

    const { data: cacheRows } = await sb
      .from('bdl_lineup_cache')
      .select('game_id,home_lineup,away_lineup,home_pitcher,away_pitcher,home_source,away_source,fetched_at')
      .in('game_id', gameIds)

    type CacheRow = { game_id: number; home_lineup: unknown; away_lineup: unknown; home_pitcher: unknown; away_pitcher: unknown; home_source: unknown; away_source: unknown; fetched_at: unknown }
    const cacheMap = new Map<number, CacheRow>()
    const now = Date.now()
    for (const row of cacheRows ?? []) {
      const gid = Number(row.game_id)
      const age = now - new Date((row as any).fetched_at).getTime()
      if (age < LINEUP_CACHE_TTL_MS) cacheMap.set(gid, row as any)
    }

    if (games.every((g) => cacheMap.has(g.bdl_game_id))) {
      for (const game of games) {
        out[String(game.bdl_game_id)] = resultFromCacheRow(game.bdl_game_id, cacheMap.get(game.bdl_game_id)!)
      }
    } else {
      const uncachedGames = games.filter((g) => !cacheMap.has(g.bdl_game_id))
      const officialMap = await fetchOfficialLineupsForGames(sb, uncachedGames)

      const toCache: Array<{
        game_id: number; date: string
        home_lineup: TeamLineupPlayer[]; away_lineup: TeamLineupPlayer[]
        home_pitcher: TeamPitcherInfo | null; away_pitcher: TeamPitcherInfo | null
        home_source: TeamLineupSource; away_source: TeamLineupSource
        fetched_at: string
      }> = []

      for (const game of games) {
        if (cacheMap.has(game.bdl_game_id)) {
          out[String(game.bdl_game_id)] = resultFromCacheRow(game.bdl_game_id, cacheMap.get(game.bdl_game_id)!)
          continue
        }

        const official = officialMap.get(game.bdl_game_id) ?? null
        const homeOfficial = official?.home ?? []
        const awayOfficial = official?.away ?? []

        const home =
          batterCount(homeOfficial) >= 9
            ? homeOfficial
            : await findRecentTeamLineup(sb, game.home_team_abbrev, game.start_time_utc ?? null)
        const away =
          batterCount(awayOfficial) >= 9
            ? awayOfficial
            : await findRecentTeamLineup(sb, game.away_team_abbrev, game.start_time_utc ?? null)

        const homePitcher = firstPitcher(homeOfficial) ?? firstPitcher(home)
        const awayPitcher = firstPitcher(awayOfficial) ?? firstPitcher(away)
        const homeSource: TeamLineupSource = batterCount(homeOfficial) >= 9 ? 'official' : home.length ? 'previous_game' : 'none'
        const awaySource: TeamLineupSource = batterCount(awayOfficial) >= 9 ? 'official' : away.length ? 'previous_game' : 'none'

        out[String(game.bdl_game_id)] = {
          game_id: game.bdl_game_id,
          home,
          away,
          home_pitcher: homePitcher,
          away_pitcher: awayPitcher,
          home_source: homeSource,
          away_source: awaySource,
        }

        toCache.push({
          game_id: game.bdl_game_id,
          date: dateIso,
          home_lineup: home,
          away_lineup: away,
          home_pitcher: homePitcher,
          away_pitcher: awayPitcher,
          home_source: homeSource,
          away_source: awaySource,
          fetched_at: new Date().toISOString(),
        })
      }

      if (toCache.length) {
        sb.from('bdl_lineup_cache').upsert(toCache, { onConflict: 'game_id' }).then(({ error }) => {
          if (error) console.warn('[lineups] cache write failed:', error.message)
        })
      }
    }
  }

  for (const r of schedList) {
    const pk = teamPairKey(r.home_team, r.away_team)
    if (bdlPairKeys.has(pk)) continue
    const best = await getBestLineupForGame(sb, {
      dateIso,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      gameId: null,
    })
    out[String(r.game_id)] = best
  }

  return out
}
