/**
 * Daily HR projection engine.
 *
 * Runs once per daily sync. For every batter on a team playing today,
 * computes calibrated per-game HR probability using the new logistic model
 * with pitch arsenal matchups, park factors, weather, handedness, and lineup data.
 * Results are persisted to `daily_hr_projections` for instant frontend reads.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from './supabase.js'
import { config } from './config.js'
import { bdlFetch } from './bdl/client.js'
import { getBestLineupForGame, getResolvedGamesForDate } from './bdl/lineups.js'
import {
  getBallparkForHomeTeam,
  type BallparkInfo,
} from './weather/mlbBallparks.js'
import { fetchOneCallWeather, type OneCallPayload } from './weather/openWeather.js'

import {
  zHrPerPa,
  zPower,
  zPark,
  zHandedness,
  zWeather as computeZWeather,
  zLineupSpot,
  zRecentForm,
  expectedPaForSpot,
  type BatterFeatureInput,
  type WeatherInput,
  type Hand,
} from './models/hr/features.js'
import {
  computeArsenalScore,
  zArsenal,
  zPitcherFallback,
  type PitchArsenalEntry,
  type BatterVsPitchType,
} from './models/hr/arsenal.js'
import {
  computeGameHrProbability,
  probToAmericanOdds,
  formatAmericanOdds,
  type NormalizedFeatures,
} from './models/hr/hrProbability.js'
import { type CalibrationCoeffKey } from './models/hr/calibration.js'

/* ─── Team canonicalization ──────────────────────────────────────── */

const TEAM_ALIASES: Record<string, string> = {
  AZ: 'ARI', ARI: 'ARI', WSH: 'WSN', WAS: 'WSN', WSN: 'WSN',
  CWS: 'CHW', CHW: 'CHW', KC: 'KCR', KCR: 'KCR', SF: 'SFG',
  SFG: 'SFG', SD: 'SDP', SDP: 'SDP', TB: 'TBR', TBR: 'TBR',
  OAK: 'ATH', ATH: 'ATH',
}

function canon(team: string | null | undefined): string | null {
  if (!team) return null
  const k = team.trim().toUpperCase()
  return TEAM_ALIASES[k] ?? k
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function todayET(): string {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function etDateFromUtc(utcStr: string | null | undefined): string | null {
  if (!utcStr) return null
  try {
    const d = new Date(new Date(utcStr).toLocaleString('en-US', { timeZone: 'America/New_York' }))
    if (Number.isNaN(d.getTime())) return null
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  } catch {
    return null
  }
}

/* ─── Data fetching ──────────────────────────────────────────────── */

async function fetchGames(sb: SupabaseClient, date: string) {
  const resolved = await getResolvedGamesForDate(sb, date)
  const byPair = new Map<string, { bdl_game_id: number; home_team_abbrev: string; away_team_abbrev: string }>()
  for (const g of resolved) {
    byPair.set(`${canon(g.away_team_abbrev)}|${canon(g.home_team_abbrev)}`, {
      bdl_game_id: g.bdl_game_id,
      home_team_abbrev: g.home_team_abbrev,
      away_team_abbrev: g.away_team_abbrev,
    })
  }
  const { data: sched } = await sb
    .from('schedule_games')
    .select('home_team, away_team')
    .eq('date', date)
  return (sched ?? []).map((g: any) => {
    const key = `${canon(g.away_team)}|${canon(g.home_team)}`
    const resolvedGame = byPair.get(key)
    return {
      bdl_game_id: resolvedGame?.bdl_game_id ?? 0,
      home_team_abbrev: resolvedGame?.home_team_abbrev ?? g.home_team,
      away_team_abbrev: resolvedGame?.away_team_abbrev ?? g.away_team,
    }
  })
}

async function fetchPlayers(sb: SupabaseClient) {
  const { data } = await sb.from('players')
    .select('stat_player_id, slug, name, team, position')
    .limit(5000)
  return (data ?? []) as { stat_player_id: string; slug: string; name: string; team: string | null; position: string | null }[]
}

async function fetchBatterEV(sb: SupabaseClient, season: number) {
  const { data } = await sb.from('stats_exit_velocity')
    .select('player_id, attempts, avg_hit_speed, avg_hit_angle, ev95percent, brl_percent, fbld')
    .eq('role', 'batting').eq('season', season).limit(5000)
  return data ?? []
}

async function fetchBatterHR(sb: SupabaseClient, year: number) {
  const { data } = await sb.from('stats_homeruns')
    .select('player_id, hr_total').eq('role', 'batting').eq('type', 'adj_xhr').eq('year', year).limit(5000)
  return data ?? []
}

async function fetchBatterArsenal(sb: SupabaseClient, season: number) {
  const { data } = await sb.from('stats_pitch_arsenal')
    .select('player_id, pitch_type, run_value_per_100, pitch_usage, slg, woba, est_woba, whiff_percent')
    .eq('role', 'batting').eq('season', season).limit(10000)
  return data ?? []
}

async function fetchPitcherArsenal(sb: SupabaseClient, season: number) {
  const { data } = await sb.from('stats_pitch_arsenal')
    .select('player_id, pitch_type, run_value_per_100, pitch_usage, slg, woba, est_woba')
    .eq('role', 'pitching').eq('season', season).limit(10000)
  return data ?? []
}

async function fetchBattedBall(sb: SupabaseClient) {
  const { data } = await sb.from('stats_batted_ball')
    .select('player_id, split, metrics').eq('role', 'batting')
    .in('split', ['vs_lhp', 'vs_rhp']).limit(20000)
  return (data ?? []) as { player_id: string; split: string; metrics: Record<string, unknown> }[]
}

async function fetchParkFactors(sb: SupabaseClient) {
  const { data } = await sb.from('stats_park_factors')
    .select('venue, year_label, park_factor').eq('scope', 'overall').limit(500)
  return (data ?? []) as { venue: string; year_label: string; park_factor: number | null }[]
}

async function fetchBdlPlayers(sb: SupabaseClient) {
  const { data } = await sb.from('bdl_players')
    .select('bdl_id, stat_player_id, full_name, bats_throws, position, team_abbrev')
    .limit(5000)
  return (data ?? []) as {
    bdl_id: number; stat_player_id: string | null; full_name: string;
    bats_throws: string | null; position: string | null; team_abbrev: string | null
  }[]
}

async function fetchBdlSeasonStats(sb: SupabaseClient, season: number) {
  const { data } = await sb.from('bdl_season_stats')
    .select('bdl_player_id, batting_ab, batting_bb, batting_hr, batting_avg, batting_slg, pitching_hr, pitching_ip, pitching_era, pitching_k_per_9')
    .eq('season', season).limit(5000)
  return (data ?? []) as {
    bdl_player_id: number
    batting_ab: number | null
    batting_bb: number | null
    batting_hr: number | null
    batting_avg: number | null
    batting_slg: number | null
    pitching_hr: number | null
    pitching_ip: number | null
    pitching_era: number | null
    pitching_k_per_9: number | null
  }[]
}

async function fetchMaxBattingYear(sb: SupabaseClient): Promise<number | null> {
  const { data } = await sb.from('stats_homeruns')
    .select('year').eq('role', 'batting').eq('type', 'adj_xhr')
    .order('year', { ascending: false }).limit(1).maybeSingle()
  return data?.year != null ? Number(data.year) : null
}

/* ─── BDL lineup + probable pitcher helpers ──────────────────────── */

type BdlProbablePitcherEntry = {
  game_id: number
  home_probable_pitcher?: { id: number; full_name: string } | null
  away_probable_pitcher?: { id: number; full_name: string } | null
}

function shiftIsoDate(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function fetchBdlProbablePitchers(
  sb: SupabaseClient,
  date: string,
): Promise<Map<number, { home: number | null; away: number | null }>> {
  const map = new Map<number, { home: number | null; away: number | null }>()
  const resolvedGames = await getResolvedGamesForDate(sb, date)
  const validGameIds = new Set(resolvedGames.map((g) => Number(g.bdl_game_id)))
  if (!validGameIds.size) return map

  for (const d of [date, shiftIsoDate(date, -1), shiftIsoDate(date, 1)]) {
    try {
      const res = await bdlFetch<{ data?: BdlProbablePitcherEntry[] }>('/mlb/v1/probable_pitchers', { 'dates[]': d })
      for (const e of res.data ?? []) {
        if (!validGameIds.has(Number(e.game_id))) continue
        map.set(e.game_id, {
          home: e.home_probable_pitcher?.id ?? null,
          away: e.away_probable_pitcher?.id ?? null,
        })
      }
    } catch (e) {
      console.warn('[hr-engine] probable pitchers fetch failed:', e)
    }
  }
  return map
}

/* ─── Weather → WeatherInput conversion ─────────────────────────── */

function weatherToInput(ow: OneCallPayload, park: BallparkInfo): WeatherInput | null {
  const c = ow.current
  if (!c) return null
  const tempF = c.temp ?? 72
  const windSpeedMph = c.wind_speed ?? 0
  const windDegMeteo = c.wind_deg ?? 0
  const humidity = c.humidity ?? 50

  if (park.roof === 'dome') {
    return { tempF: 72, windSpeedMph: 0, windDirectionDeg: 90, humidityPct: 50 }
  }

  const windDirectionDeg = ((windDegMeteo - park.cfBearing) + 360) % 360
  return { tempF, windSpeedMph, windDirectionDeg, humidityPct: humidity }
}

/* ─── Park factor lookup ─────────────────────────────────────────── */

function buildVenueParkMap(rows: { venue: string; year_label: string; park_factor: number | null }[]): Map<string, number> {
  const best = new Map<string, { y: string; pf: number }>()
  for (const r of rows) {
    const pf = r.park_factor ?? 100
    const prev = best.get(r.venue)
    if (!prev || r.year_label > prev.y) best.set(r.venue, { y: r.year_label, pf })
  }
  const m = new Map<string, number>()
  for (const [venue, v] of best) m.set(venue.toLowerCase().trim(), v.pf)
  return m
}

function lookupParkFactor(homeTeam: string | null, venueLower: Map<string, number>): number | null {
  const bp = getBallparkForHomeTeam(homeTeam)
  if (!bp) return null
  const s = bp.stadium.toLowerCase()
  if (venueLower.has(s)) return venueLower.get(s)!
  for (const [k, v] of venueLower) {
    if (k.includes(s) || s.includes(k)) return v
  }
  return null
}

/* ─── Main engine ────────────────────────────────────────────────── */

export interface EngineProjection {
  playerId:    string
  slug:        string
  name:        string
  team:        string
  position:    string | null
  opponent:    string | null
  opponentPitcher:     string | null
  opponentPitcherHand: string | null
  hrProbability: number
  probRaw:     number
  tier:        string
  pPa:         number
  linearScore: number
  expectedPA:  number
  dataQuality: string
  americanOdds:    number
  americanOddsStr: string
}

export async function runDailyProjections(dateOverride?: string): Promise<EngineProjection[]> {
  const date = dateOverride ?? todayET()
  const sb = getServiceClient()
  console.log(`[hr-engine] Running projections for ${date}…`)

  const year = await fetchMaxBattingYear(sb)
  if (!year) { console.warn('[hr-engine] No stats year found'); return [] }

  const [
    games, players, evRows, hrRows, bArsenalRows, pArsenalRows,
    bbRows, parkRows, bdlPlayers, bdlStats,
  ] = await Promise.all([
    fetchGames(sb, date),
    fetchPlayers(sb),
    fetchBatterEV(sb, year),
    fetchBatterHR(sb, year),
    fetchBatterArsenal(sb, year),
    fetchPitcherArsenal(sb, year),
    fetchBattedBall(sb),
    fetchParkFactors(sb),
    fetchBdlPlayers(sb),
    fetchBdlSeasonStats(sb, 2026),
  ])

  if (!games.length) { console.log('[hr-engine] No games today'); return [] }
  console.log(`[hr-engine] ${games.length} games, ${evRows.length} EV rows, ${pArsenalRows.length} pitcher arsenal rows`)

  const probPitchers = await fetchBdlProbablePitchers(sb, date)

  // Fetch weather for each unique home team
  const homeTeams = [...new Set(games.map((g) => canon(g.home_team_abbrev)).filter(Boolean))] as string[]
  const weatherByTeam = new Map<string, WeatherInput | null>()
  if (config.openWeatherApiKey()) {
    const tasks = homeTeams.map(async (t) => {
      const bp = getBallparkForHomeTeam(t)
      if (!bp) return
      try {
        const ow = await fetchOneCallWeather(bp.lat, bp.lon)
        weatherByTeam.set(t, weatherToInput(ow, bp))
      } catch (e) {
        console.warn(`[hr-engine] weather failed for ${t}:`, e)
      }
    })
    await Promise.all(tasks)
  } else {
    console.warn('[hr-engine] OPENWEATHER_API_KEY not configured; weather feature omitted for all games')
  }

  /* ─── Index data ──────────────────────────────────────────────── */

  const playerMap = new Map(players.map((p) => [p.stat_player_id, p]))
  const evMap = new Map(evRows.map((r: any) => [r.player_id as string, r]))
  const hrMap = new Map(hrRows.map((r: any) => [r.player_id as string, r]))
  const venueLower = buildVenueParkMap(parkRows)

  const bdlByStatId = new Map<string, typeof bdlPlayers[0]>()
  const bdlById = new Map<number, typeof bdlPlayers[0]>()
  for (const bp of bdlPlayers) {
    if (bp.stat_player_id) bdlByStatId.set(bp.stat_player_id, bp)
    bdlById.set(bp.bdl_id, bp)
  }

  const bdlStatsById = new Map(bdlStats.map((s) => [s.bdl_player_id, s]))

  // Batted ball splits by player
  const bbByPlayer = new Map<string, { lhp?: Record<string, unknown>; rhp?: Record<string, unknown> }>()
  for (const row of bbRows) {
    if (!bbByPlayer.has(row.player_id)) bbByPlayer.set(row.player_id, {})
    const b = bbByPlayer.get(row.player_id)!
    if (row.split === 'vs_lhp') b.lhp = row.metrics
    if (row.split === 'vs_rhp') b.rhp = row.metrics
  }

  // Batter pitch-type RV/100 by player
  const batterRVMap = new Map<string, Map<string, number>>()
  for (const r of bArsenalRows as any[]) {
    const pid = r.player_id as string
    const rv = num(r.run_value_per_100)
    if (rv == null) continue
    if (!batterRVMap.has(pid)) batterRVMap.set(pid, new Map())
    batterRVMap.get(pid)!.set(r.pitch_type as string, rv)
  }

  // Pitcher pitch arsenal by player_id
  const pitcherArsenalMap = new Map<string, PitchArsenalEntry[]>()
  for (const r of pArsenalRows as any[]) {
    const pid = r.player_id as string
    const usage = num(r.pitch_usage) ?? 0
    const rv = num(r.run_value_per_100) ?? 0
    if (!pitcherArsenalMap.has(pid)) pitcherArsenalMap.set(pid, [])
    pitcherArsenalMap.get(pid)!.push({
      pitchType: r.pitch_type as string,
      usagePct: usage,
      pitcherRV100: rv,
    })
  }

  /* ─── Build game context ──────────────────────────────────────── */

  type GameCtx = {
    bdlGameId: number
    homeTeam: string
    awayTeam: string
    parkFactor: number | null
    weather: WeatherInput | null
    homePitcherStatId: string | null
    awayPitcherStatId: string | null
    homePitcherHand: Hand | null
    awayPitcherHand: Hand | null
    homePitcherName: string | null
    awayPitcherName: string | null
    homePitcherHrPer9: number | null
    awayPitcherHrPer9: number | null
    lineupHome: Map<string, number>
    lineupAway: Map<string, number>
  }

  function parseBatsThrows(bt: string | null | undefined): { bats: Hand; throws: Hand } {
    if (!bt) return { bats: 'R', throws: 'R' }
    const parts = bt.toUpperCase().split('/')
    const bats = (parts[0] === 'L' ? 'L' : parts[0] === 'S' ? 'S' : 'R') as Hand
    const throws = (parts[1] === 'L' ? 'L' : 'R') as Hand
    return { bats, throws }
  }

  function resolveStatIdFromBdl(bdlId: number | null): string | null {
    if (!bdlId) return null
    return bdlById.get(bdlId)?.stat_player_id ?? null
  }

  function pitcherHandFromBdl(bdlId: number | null): Hand | null {
    if (!bdlId) return null
    const bp = bdlById.get(bdlId)
    if (!bp) return null
    return parseBatsThrows(bp.bats_throws).throws
  }

  function pitcherNameFromBdl(bdlId: number | null): string | null {
    if (!bdlId) return null
    return bdlById.get(bdlId)?.full_name ?? null
  }

  function hrPer9FromBdl(bdlId: number | null): number | null {
    if (!bdlId) return null
    const s = bdlStatsById.get(bdlId)
    if (!s || !s.pitching_ip || s.pitching_ip <= 0) return null
    const hr = s.pitching_hr ?? 0
    return (hr / (s.pitching_ip as number)) * 9
  }

  const gameContexts: GameCtx[] = await Promise.all(games.map(async (g) => {
    const home = canon(g.home_team_abbrev)!
    const away = canon(g.away_team_abbrev)!
    const pp = probPitchers.get(g.bdl_game_id)
    const bestLineup = await getBestLineupForGame(sb, {
      dateIso: date,
      gameId: g.bdl_game_id || null,
      homeTeam: home,
      awayTeam: away,
    })

    const lineupHome = new Map<string, number>()
    const lineupAway = new Map<string, number>()
    for (const entry of bestLineup.home) {
      if (entry.stat_player_id) lineupHome.set(entry.stat_player_id, entry.batting_order ?? 0)
    }
    for (const entry of bestLineup.away) {
      if (entry.stat_player_id) lineupAway.set(entry.stat_player_id, entry.batting_order ?? 0)
    }

    return {
      bdlGameId: g.bdl_game_id,
      homeTeam: home,
      awayTeam: away,
      parkFactor: lookupParkFactor(home, venueLower),
      weather: weatherByTeam.get(home) ?? null,
      homePitcherStatId: resolveStatIdFromBdl(pp?.home ?? null),
      awayPitcherStatId: resolveStatIdFromBdl(pp?.away ?? null),
      homePitcherHand: pitcherHandFromBdl(pp?.home ?? null),
      awayPitcherHand: pitcherHandFromBdl(pp?.away ?? null),
      homePitcherName: pitcherNameFromBdl(pp?.home ?? null),
      awayPitcherName: pitcherNameFromBdl(pp?.away ?? null),
      homePitcherHrPer9: hrPer9FromBdl(pp?.home ?? null),
      awayPitcherHrPer9: hrPer9FromBdl(pp?.away ?? null),
      lineupHome,
      lineupAway,
    }
  }))

  /* ─── Build team → game context map ───────────────────────────── */

  const teamGameMap = new Map<string, { ctx: GameCtx; side: 'home' | 'away' }>()
  for (const ctx of gameContexts) {
    teamGameMap.set(ctx.homeTeam, { ctx, side: 'home' })
    teamGameMap.set(ctx.awayTeam, { ctx, side: 'away' })
  }

  /* ─── Project each batter ─────────────────────────────────────── */

  const teamsPlaying = new Set<string>()
  for (const ctx of gameContexts) {
    teamsPlaying.add(ctx.homeTeam)
    teamsPlaying.add(ctx.awayTeam)
  }

  const rosterPlayerIds = new Set<string>()
  for (const bp of bdlPlayers) {
    const team = canon(bp.team_abbrev)
    if (team && teamsPlaying.has(team) && bp.stat_player_id) {
      rosterPlayerIds.add(bp.stat_player_id)
    }
  }
  for (const p of players) {
    const team = canon(p.team)
    if (team && teamsPlaying.has(team)) {
      rosterPlayerIds.add(p.stat_player_id)
    }
  }

  const results: EngineProjection[] = []

  for (const playerId of rosterPlayerIds) {
    const player = playerMap.get(playerId)
    if (!player) continue
    const pTeam = canon(player.team)
    if (!pTeam) continue
    const gm = teamGameMap.get(pTeam)
    if (!gm) continue

    const { ctx, side } = gm
    const oppTeam = side === 'home' ? ctx.awayTeam : ctx.homeTeam
    const ev = evMap.get(playerId)
    const hr = hrMap.get(playerId)
    const bdlInfo = bdlByStatId.get(playerId)
    const seasonBatting = bdlInfo ? bdlStatsById.get(bdlInfo.bdl_id) : null

    const positionRaw = String(bdlInfo?.position ?? player.position ?? '').toUpperCase()
    if (positionRaw === 'P' || positionRaw === 'SP' || positionRaw === 'RP') continue

    const seasonPa =
      (seasonBatting?.batting_ab ?? 0) +
      (seasonBatting?.batting_bb ?? 0)
    const attempts = num((ev as any)?.attempts) ?? (seasonPa > 0 ? seasonPa : 0)
    const hrTotal = num((hr as any)?.hr_total) ?? seasonBatting?.batting_hr ?? 0
    const brlPct = num((ev as any)?.brl_percent) ?? 0
    if (attempts <= 0 && hrTotal <= 0 && brlPct <= 0) continue

    const hrPerPaVal = attempts > 0 ? hrTotal / attempts : null
    const isoVal =
      seasonBatting?.batting_slg != null && seasonBatting?.batting_avg != null
        ? Number(seasonBatting.batting_slg) - Number(seasonBatting.batting_avg)
        : null
    if (hrPerPaVal == null && brlPct <= 0 && isoVal == null) continue

    // Determine opposing pitcher info
    const oppPitcherStatId = side === 'home' ? ctx.awayPitcherStatId : ctx.homePitcherStatId
    const oppPitcherHand   = side === 'home' ? ctx.awayPitcherHand   : ctx.homePitcherHand
    const oppPitcherName   = side === 'home' ? ctx.awayPitcherName   : ctx.homePitcherName
    const oppPitcherHrPer9 = side === 'home' ? ctx.awayPitcherHrPer9 : ctx.homePitcherHrPer9

    // Batter hand from BDL
    const { bats: batterHand } = parseBatsThrows(bdlInfo?.bats_throws)

    // Lineup position
    const lineupMap = side === 'home' ? ctx.lineupHome : ctx.lineupAway
    const lineupPos = lineupMap.get(playerId) ?? null

    // Batted ball splits for handedness
    const bb = bbByPlayer.get(playerId)
    const baseHrRate = hrPerPaVal ?? 0
    const isoRaw = num((ev as any).avg_hit_speed) != null
      ? null
      : null
    let hrPerPaVsL: number | null = null
    let hrPerPaVsR: number | null = null
    if (bb?.lhp) {
      const hrl = num(bb.lhp['HR/FB'])
      const fbl = num(bb.lhp['FB%'])
      if (hrl != null && fbl != null && fbl > 0) {
        hrPerPaVsL = (hrl / 100) * (fbl / 100) * baseHrRate / 0.036 * 0.036
      }
    }
    if (bb?.rhp) {
      const hrr = num(bb.rhp['HR/FB'])
      const fbr = num(bb.rhp['FB%'])
      if (hrr != null && fbr != null && fbr > 0) {
        hrPerPaVsR = (hrr / 100) * (fbr / 100) * baseHrRate / 0.036 * 0.036
      }
    }

    const batterInput: BatterFeatureInput = {
      hrPerPa:       hrPerPaVal,
      barrelRate:    num((ev as any)?.brl_percent),
      iso:           isoVal,
      hand:          batterHand,
      lineupPosition: lineupPos,
      hrPerPaVsL,
      hrPerPaVsR,
      hrLast7:       null,
      paLast7:       null,
      hrLast14:      null,
      paLast14:      null,
    }

    /* ── Arsenal matchup score ──────────────────────────────────── */
    let arsenalZ: number | null = null
    let arsenalRaw = 0
    let arsenalDetail: unknown[] = []
    let hasArsenal = false

    if (oppPitcherStatId) {
      const pitcherPitches = pitcherArsenalMap.get(oppPitcherStatId) ?? []
      const batterRV = batterRVMap.get(playerId)

      if (pitcherPitches.length > 0 && batterRV && batterRV.size > 0) {
        const batterSplits: BatterVsPitchType[] = []
        for (const [pt, rv] of batterRV) {
          batterSplits.push({ pitchType: pt, batterRV100: rv })
        }
        const result = computeArsenalScore(pitcherPitches, batterSplits)
        arsenalRaw = result.raw
        arsenalDetail = result.detail
        arsenalZ = zArsenal(arsenalRaw)
        hasArsenal = true
      }
    }

    if (!hasArsenal && oppPitcherHrPer9 != null) {
      arsenalZ = zPitcherFallback(oppPitcherHrPer9)
    }

    /* ── Assemble features ──────────────────────────────────────── */
    const present: CalibrationCoeffKey[] = []

    const fZHrPerPa = zHrPerPa(hrPerPaVal)
    if (fZHrPerPa != null) present.push('hrPerPa')

    const fZPower = zPower(batterInput)
    if (fZPower != null) present.push('power')

    if (arsenalZ != null) present.push('arsenal')

    const fZPark = zPark(ctx.parkFactor)
    if (fZPark != null) present.push('park')

    const fZHand = zHandedness(batterInput, oppPitcherHand)
    if (fZHand != null) present.push('handedness')

    const fZWeather = computeZWeather(ctx.weather)
    if (fZWeather != null) present.push('weather')

    const fZRecent7 = zRecentForm(batterInput.hrLast7 ?? null, batterInput.paLast7 ?? null, 7)
    if (fZRecent7 !== 0) present.push('recentForm7')

    const fZRecent14 = zRecentForm(batterInput.hrLast14 ?? null, batterInput.paLast14 ?? null, 14)
    if (fZRecent14 !== 0) present.push('recentForm14')

    const fZLineup = zLineupSpot(lineupPos)
    if (fZLineup !== 0) present.push('lineupSpot')

    const expPA = expectedPaForSpot(lineupPos)

    const features: NormalizedFeatures = {
      zHrPerPa:      fZHrPerPa,
      zPower:        fZPower,
      zArsenal:      arsenalZ,
      zPark:         fZPark,
      zHandedness:   fZHand,
      zWeather:      fZWeather,
      zRecentForm7:  fZRecent7,
      zRecentForm14: fZRecent14,
      zLineupSpot:   fZLineup,
      expectedPA:    expPA,
      arsenalRaw,
      arsenalDetail,
      featuresPresent: present,
    }

    const out = computeGameHrProbability(features)
    const americanOdds = probToAmericanOdds(out.probability)

    results.push({
      playerId,
      slug: player.slug ?? '',
      name: player.name ?? 'Unknown',
      team: pTeam,
      position: player.position ?? null,
      opponent: side === 'home' ? `vs ${oppTeam}` : `@ ${oppTeam}`,
      opponentPitcher: oppPitcherName,
      opponentPitcherHand: oppPitcherHand,
      hrProbability: out.probability,
      probRaw: out.probRaw,
      tier: out.tier,
      pPa: out.pPa,
      linearScore: out.x,
      expectedPA: expPA,
      dataQuality: out.dataQuality,
      americanOdds,
      americanOddsStr: formatAmericanOdds(americanOdds),
    })
  }

  results.sort((a, b) => b.hrProbability - a.hrProbability)
  console.log(`[hr-engine] Computed ${results.length} projections. Top: ${results[0]?.name ?? 'none'} ${(results[0]?.hrProbability * 100)?.toFixed(1)}%`)
  return results
}

/* ─── Persist to daily_hr_projections ────────────────────────────── */

export async function runAndSaveProjections(dateOverride?: string): Promise<{ computed: number; saved: number }> {
  const date = dateOverride ?? todayET()
  const projections = await runDailyProjections(date)
  if (!projections.length) return { computed: 0, saved: 0 }

  const sb = getServiceClient()

  // Delete existing projections for this date to avoid stale data
  await sb.from('daily_hr_projections').delete().eq('date', date)

  const rows = projections.map((p) => ({
    date,
    player_id:             p.playerId,
    opponent_pitcher:      p.opponentPitcher,
    opponent_pitcher_hand: p.opponentPitcherHand,
    hr_probability:        p.hrProbability,
    l7_hrs:                null,
    tier:                  p.tier,
  }))

  const BATCH = 200
  let saved = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const { error } = await sb.from('daily_hr_projections').upsert(batch, {
      onConflict: 'date,player_id',
      ignoreDuplicates: false,
    })
    if (error) {
      console.error(`[hr-engine] upsert batch ${i} failed:`, error.message)
    } else {
      saved += batch.length
    }
  }

  console.log(`[hr-engine] Saved ${saved}/${projections.length} projections for ${date}`)
  return { computed: projections.length, saved }
}

export async function runUpcomingLineupRefresh(windowMinutes = 60) {
  const sb = getServiceClient()
  const now = new Date()
  const end = new Date(now.getTime() + windowMinutes * 60 * 1000)

  const { data } = await sb
    .from('bdl_games')
    .select('bdl_game_id,start_time_utc')
    .gte('start_time_utc', now.toISOString())
    .lte('start_time_utc', end.toISOString())
    .order('start_time_utc', { ascending: true })

  const dates = [
    ...new Set(
      ((data ?? []) as Array<{ start_time_utc: string | null }>)
        .map((g) => etDateFromUtc(g.start_time_utc))
        .filter((d): d is string => Boolean(d)),
    ),
  ]

  let computed = 0
  let saved = 0
  for (const date of dates) {
    const result = await runAndSaveProjections(date)
    computed += result.computed
    saved += result.saved
  }

  return {
    windowMinutes,
    dates,
    computed,
    saved,
  }
}
