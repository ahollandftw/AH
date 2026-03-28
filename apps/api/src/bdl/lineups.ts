import type { SupabaseClient } from '@supabase/supabase-js'
import { bdlFetch } from './client.js'

export type TeamLineupPlayer = {
  bdl_player_id: number | null
  stat_player_id: string | null
  full_name: string | null
  position: string | null
  batting_order: number | null
}

export type TeamLineupSource = 'official' | 'previous_game' | 'none'

export type GameLineupResult = {
  game_id: number | null
  home: TeamLineupPlayer[]
  away: TeamLineupPlayer[]
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

async function mapRawLineup(
  sb: SupabaseClient,
  entries: RawLineupEntry[],
): Promise<TeamLineupPlayer[]> {
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

  const xrefMap = new Map<number, { stat_player_id: string | null; full_name: string | null }>(
    (xref ?? []).map((r: any) => [
      Number(r.bdl_id),
      { stat_player_id: r.stat_player_id ?? null, full_name: r.full_name ?? null },
    ]),
  )

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

async function fetchOfficialGameLineup(
  sb: SupabaseClient,
  gameId: number,
): Promise<{ home: TeamLineupPlayer[]; away: TeamLineupPlayer[] } | null> {
  try {
    const res = await bdlFetch<{
      data?: {
        home?: RawLineupEntry[]
        away?: RawLineupEntry[]
        home_lineup?: RawLineupEntry[]
        away_lineup?: RawLineupEntry[]
      }
    }>('/mlb/v1/lineups', { game_id: gameId })

    const payload = res.data ?? {}
    const homeRaw = payload.home_lineup ?? payload.home ?? []
    const awayRaw = payload.away_lineup ?? payload.away ?? []
    if (!homeRaw.length && !awayRaw.length) return null

    return {
      home: await mapRawLineup(sb, homeRaw),
      away: await mapRawLineup(sb, awayRaw),
    }
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
    const official = await fetchOfficialGameLineup(sb, game.bdl_game_id)
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
  const official = game?.bdl_game_id ? await fetchOfficialGameLineup(sb, game.bdl_game_id) : null

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
