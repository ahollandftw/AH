import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchMaxBattingHomerunYear } from './statsQueries'
import { getAppDisplayDateIso } from './displayDate'
import {
  formatAmericanOdds,
  probToAmericanOdds,
  probToTier,
} from './hrProbability'
import { getBallparkForHomeTeam } from './mlbBallparks'
import {
  computeGameHrProbability,
  type NormalizedFeatures,
} from './models/hr/hrProbability.js'
import { type CalibrationCoeffKey } from './models/hr/calibration.js'
import { expectedPaFromLineupSlot } from './models/hr/expectedPA.js'
import {
  zHrPerPa as computeZHrPerPa,
  zPower as computeZPower,
  zPark as computeZPark,
  type BatterFeatureInput,
} from './models/hr/features.js'
import {
  computeArsenalScore,
  zArsenal,
  type PitchArsenalEntry,
  type BatterVsPitchType,
} from './models/hr/arsenal.js'

export type DailyProjection = {
  playerId: string
  slug: string
  name: string
  team: string | null
  position: string | null
  opponentPitcher: string | null
  opponentPitcherHand: string | null
  hrProbability: number | null
  l7Hrs: number | null
  tier: string | null
  opponent: string | null
  americanOdds: number | null
  americanOddsStr: string | null
  source?: 'daily_table' | 'hr_model'
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

const TEAM_ALIASES: Record<string, string> = {
  AZ: 'ARI', ARI: 'ARI', WSH: 'WSN', WAS: 'WSN', WSN: 'WSN',
  CWS: 'CHW', CHW: 'CHW', KC: 'KCR', KCR: 'KCR', SF: 'SFG',
  SFG: 'SFG', SD: 'SDP', SDP: 'SDP', TB: 'TBR', TBR: 'TBR',
  OAK: 'ATH', ATH: 'ATH',
}

function canonicalTeam(team: string | null | undefined): string | null {
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

function hasBrokenCapDistribution(rows: DailyProjection[]): boolean {
  if (rows.length < 20) return false
  const capped = rows.filter((r) => (r.hrProbability ?? 0) >= 0.3299).length
  return capped / rows.length >= 0.9
}

/* ─── daily_hr_projections table read ────────────────────────────── */

async function listDailyHrProjectionsFromTable(
  supabase: SupabaseClient,
  dateIso: string,
): Promise<DailyProjection[]> {
  const games = await getGamesForDateRaw(supabase, dateIso)
  const matchupDisplayMap = new Map<string, string>()
  for (const g of games) {
    const home = canonicalTeam(g.home_team) ?? g.home_team
    const away = canonicalTeam(g.away_team) ?? g.away_team
    matchupDisplayMap.set(home, `vs ${away}`)
    matchupDisplayMap.set(away, `@ ${home}`)
  }
  const { data, error } = await supabase
    .from('daily_hr_projections')
    .select(
      'player_id, opponent_pitcher, opponent_pitcher_hand, hr_probability, l7_hrs, tier, players:player_id (stat_player_id,slug,name,team,position)',
    )
    .eq('date', dateIso)
    .order('hr_probability', { ascending: false, nullsFirst: false })

  if (error || !data) return []

  return data
    .map((row: any) => {
      const p = row.hr_probability != null ? Number(row.hr_probability) : null
      const prob = p != null && Number.isFinite(p) ? p : null
      return {
        playerId: row.players?.stat_player_id ?? row.player_id,
        slug: row.players?.slug ?? '',
        name: row.players?.name ?? 'Unknown',
        team: canonicalTeam(row.players?.team) ?? row.players?.team ?? null,
        position: row.players?.position ?? null,
        opponentPitcher: row.opponent_pitcher ?? null,
        opponentPitcherHand: row.opponent_pitcher_hand ?? null,
        hrProbability: prob,
        l7Hrs: row.l7_hrs ?? null,
        tier: prob != null ? probToTier(prob) : (row.tier ?? null),
        opponent: matchupDisplayMap.get(canonicalTeam(row.players?.team) ?? row.players?.team ?? '') ?? null,
        americanOdds: prob != null ? probToAmericanOdds(prob) : null,
        americanOddsStr: prob != null ? formatAmericanOdds(probToAmericanOdds(prob)) : null,
        source: 'daily_table' as const,
      }
    })
    .filter((p: DailyProjection) => p.name !== 'Unknown')
}

/* ─── Batch data helpers ─────────────────────────────────────────── */

async function fetchAllBatterEV(supabase: SupabaseClient, season: number) {
  const { data } = await supabase
    .from('stats_exit_velocity')
    .select('player_id, season, attempts, avg_hit_speed, ev95percent, brl_percent, fbld, gb')
    .eq('role', 'batting')
    .lte('season', season)
    .order('season', { ascending: false })
    .limit(30000)
  return (data ?? []) as any[]
}

async function fetchAllBatterHR(supabase: SupabaseClient, year: number) {
  const { data } = await supabase
    .from('stats_homeruns')
    .select('player_id, year, hr_total')
    .eq('role', 'batting')
    .eq('type', 'adj_xhr')
    .lte('year', year)
    .order('year', { ascending: false })
    .limit(30000)
  return (data ?? []) as any[]
}

async function fetchAllBatterArsenal(supabase: SupabaseClient, season: number) {
  const { data } = await supabase
    .from('stats_pitch_arsenal')
    .select('player_id, season, pitch_type, run_value_per_100, pitch_usage, slg, est_woba, woba')
    .eq('role', 'batting')
    .lte('season', season)
    .order('season', { ascending: false })
    .limit(40000)
  return (data ?? []) as any[]
}

async function fetchAllPitcherArsenal(supabase: SupabaseClient, season: number) {
  const { data } = await supabase
    .from('stats_pitch_arsenal')
    .select('player_id, season, team_name_alt, pitch_type, run_value_per_100, pitch_usage')
    .eq('role', 'pitching')
    .lte('season', season)
    .order('season', { ascending: false })
    .limit(40000)
  return (data ?? []) as any[]
}

async function fetchParkFactors(supabase: SupabaseClient) {
  const { data } = await supabase
    .from('stats_park_factors')
    .select('scope, venue, year_label, park_factor')
    .eq('scope', 'overall').limit(500)
  return (data ?? []) as { scope: string; venue: string; year_label: string; park_factor: number | null }[]
}

async function fetchBattedBallBatting(supabase: SupabaseClient) {
  const { data } = await supabase
    .from('stats_batted_ball')
    .select('player_id, split, metrics')
    .eq('role', 'batting').in('split', ['vs_lhp', 'vs_rhp']).limit(20000)
  return (data ?? []) as { player_id: string; split: string; metrics: Record<string, unknown> }[]
}

function buildVenueParkMap(rows: { venue: string; year_label: string; park_factor: number | null }[]): Map<string, number> {
  const best = new Map<string, { y: string; pf: number }>()
  for (const r of rows) {
    const pf = r.park_factor ?? 100
    const prev = best.get(r.venue)
    if (!prev || r.year_label > prev.y) best.set(r.venue, { y: r.year_label, pf })
  }
  const lower = new Map<string, number>()
  for (const [venue, v] of best) lower.set(venue.toLowerCase().trim(), v.pf)
  return lower
}

function lookupParkFactorForHomeTeam(homeTeam: string | null, venueLower: Map<string, number>): number | null {
  const bp = getBallparkForHomeTeam(homeTeam)
  if (!bp) return null
  const s = bp.stadium.toLowerCase()
  if (venueLower.has(s)) return venueLower.get(s)!
  for (const [k, v] of venueLower) {
    if (k.includes(s) || s.includes(k)) return v
  }
  return null
}

/* ─── On-demand matchup projection engine ────────────────────────── */

async function calculateMatchupProjections(
  supabase: SupabaseClient,
  dateIso: string,
): Promise<DailyProjection[]> {
  const games = await getGamesForDateRaw(supabase, dateIso)
  if (!games.length) return []

  const teamsPlaying = new Set<string>()
  const opponentMap = new Map<string, string>()
  const matchupDisplayMap = new Map<string, string>()
  const homeAway = new Map<string, 'H' | 'A'>()

  for (const g of games) {
    const home = canonicalTeam(g.home_team) ?? g.home_team
    const away = canonicalTeam(g.away_team) ?? g.away_team
    teamsPlaying.add(home); teamsPlaying.add(away)
    opponentMap.set(home, away); opponentMap.set(away, home)
    matchupDisplayMap.set(home, `vs ${away}`); matchupDisplayMap.set(away, `@ ${home}`)
    homeAway.set(home, 'H'); homeAway.set(away, 'A')
  }

  const year = await fetchMaxBattingHomerunYear(supabase)
  if (year == null) return []

  const [evRows, hrRows, bArsenalRows, pArsenalRows, bbRows, parkRows, playersRes, bdlPlayersRes, bdlSeasonStatsRes] =
    await Promise.all([
      fetchAllBatterEV(supabase, year),
      fetchAllBatterHR(supabase, year),
      fetchAllBatterArsenal(supabase, year),
      fetchAllPitcherArsenal(supabase, year),
      fetchBattedBallBatting(supabase),
      fetchParkFactors(supabase),
      supabase.from('players').select('stat_player_id,slug,name,team,position').limit(5000),
      supabase.from('bdl_players').select('bdl_id,stat_player_id,full_name,team_abbrev,position').limit(5000),
      supabase
        .from('bdl_season_stats')
        .select('bdl_player_id,season,batting_ab,batting_bb,batting_hr')
        .lte('season', year)
        .order('season', { ascending: false })
        .limit(30000),
    ])

  const players = (playersRes.data ?? []) as any[]
  const bdlPlayers = (bdlPlayersRes.data ?? []) as any[]
  const bdlSeasonStats = (bdlSeasonStatsRes.data ?? []) as any[]
  const evMap = new Map<string, any>()
  for (const r of evRows as any[]) {
    const pid = String(r.player_id ?? '')
    if (!pid || evMap.has(pid)) continue
    evMap.set(pid, r)
  }
  const hrMap = new Map<string, any>()
  for (const r of hrRows as any[]) {
    const pid = String(r.player_id ?? '')
    if (!pid || hrMap.has(pid)) continue
    hrMap.set(pid, r)
  }
  const playerMap = new Map(players.map((p: any) => [p.stat_player_id, p]))
  for (const bp of bdlPlayers) {
    const pid = bp.stat_player_id
    if (!pid || playerMap.has(pid)) continue
    playerMap.set(pid, {
      stat_player_id: pid,
      slug: '',
      name: bp.full_name ?? 'Unknown',
      team: canonicalTeam(bp.team_abbrev) ?? bp.team_abbrev ?? null,
      position: bp.position ?? null,
    })
  }
  const bdlByStatId = new Map<string, any>()
  for (const bp of bdlPlayers) {
    if (bp.stat_player_id && !bdlByStatId.has(bp.stat_player_id)) bdlByStatId.set(bp.stat_player_id, bp)
  }
  const bdlStatsById = new Map<number, any>()
  for (const row of bdlSeasonStats) {
    if (!bdlStatsById.has(Number(row.bdl_player_id))) bdlStatsById.set(Number(row.bdl_player_id), row)
  }
  const venueLower = buildVenueParkMap(parkRows)

  const bbByPlayer = new Map<string, { lhp?: Record<string, unknown>; rhp?: Record<string, unknown> }>()
  for (const row of bbRows) {
    if (!bbByPlayer.has(row.player_id)) bbByPlayer.set(row.player_id, {})
    const b = bbByPlayer.get(row.player_id)!
    if (row.split === 'vs_lhp') b.lhp = row.metrics
    if (row.split === 'vs_rhp') b.rhp = row.metrics
  }

  // Batter RV/100 by pitch type
  const batterRVMap = new Map<string, Map<string, number>>()
  const batterArsenalSeason = new Map<string, number>()
  for (const r of bArsenalRows as any[]) {
    const pid = String(r.player_id ?? '')
    const seasonNum = Number(r.season ?? 0) || 0
    const seenSeason = batterArsenalSeason.get(pid)
    if (seenSeason != null && seasonNum < seenSeason) continue
    if (seenSeason == null || seasonNum > seenSeason) {
      batterArsenalSeason.set(pid, seasonNum)
      batterRVMap.set(pid, new Map())
    }
    const rv = num(r.run_value_per_100)
    if (rv == null) continue
    if (!batterRVMap.has(pid)) batterRVMap.set(pid, new Map())
    batterRVMap.get(pid)!.set(r.pitch_type, rv)
  }

  // Pitcher arsenal by team (aggregate)
  const teamPitchBuckets = new Map<string, Map<string, { totalUsage: number; totalRV: number; count: number }>>()
  const latestPitcherSeason = new Map<string, number>()
  for (const r of pArsenalRows as any[]) {
    const pid = String(r.player_id ?? '')
    const seasonNum = Number(r.season ?? 0) || 0
    const seenSeason = latestPitcherSeason.get(pid)
    if (seenSeason != null && seasonNum < seenSeason) continue
    if (seenSeason == null || seasonNum > seenSeason) {
      latestPitcherSeason.set(pid, seasonNum)
    }
    const t = canonicalTeam(r.team_name_alt) ?? r.team_name_alt
    if (!teamPitchBuckets.has(t)) teamPitchBuckets.set(t, new Map())
    const m = teamPitchBuckets.get(t)!
    const pt = r.pitch_type as string
    const usage = num(r.pitch_usage) ?? 0
    const rv = num(r.run_value_per_100) ?? 0
    if (!m.has(pt)) m.set(pt, { totalUsage: 0, totalRV: 0, count: 0 })
    const b = m.get(pt)!
    b.totalUsage += usage; b.totalRV += rv; b.count += 1
  }
  const teamPitcherArsenal = new Map<string, PitchArsenalEntry[]>()
  for (const [t, pitchMap] of teamPitchBuckets) {
    const entries: PitchArsenalEntry[] = []
    for (const [pt, b] of pitchMap) {
      if (b.count === 0) continue
      entries.push({ pitchType: pt, usagePct: b.totalUsage / b.count, pitcherRV100: b.totalRV / b.count })
    }
    teamPitcherArsenal.set(t, entries)
  }

  const results: DailyProjection[] = []

  for (const [playerId, ev] of evMap) {
    const player = playerMap.get(playerId) as any
    if (!player) continue
    const pTeam = canonicalTeam(player.team)
    if (!pTeam || !teamsPlaying.has(pTeam)) continue

    const oppTeam = opponentMap.get(pTeam) ?? null
    const hr = hrMap.get(playerId) as any
    const bdlInfo = bdlByStatId.get(playerId) ?? null
    const battingStats = bdlInfo?.bdl_id ? bdlStatsById.get(Number(bdlInfo.bdl_id)) ?? null : null
    const seasonPa =
      (num(battingStats?.batting_ab) ?? 0) +
      (num(battingStats?.batting_bb) ?? 0)
    const attempts = seasonPa > 0 ? seasonPa : (num(ev.attempts) ?? 0)
    const hrTotal = num(battingStats?.batting_hr) ?? num(hr?.hr_total) ?? 0
    const brlPct = num(ev.brl_percent) ?? 0
    if (hrTotal <= 0 && brlPct <= 0) continue

    const hrPerPa = attempts > 0 ? hrTotal / attempts : null
    if (hrPerPa == null) continue

    const ha = homeAway.get(pTeam) ?? null
    const parkTeam = ha === 'H' ? pTeam : oppTeam
    const parkFactor = lookupParkFactorForHomeTeam(parkTeam, venueLower)

    const batterInput: BatterFeatureInput = {
      hrPerPa, barrelRate: num(ev.brl_percent), iso: null, hand: 'R', lineupPosition: null,
    }

    let arsenalZ: number | null = null
    const oppArsenal = oppTeam ? teamPitcherArsenal.get(oppTeam) : null
    const batterRV = batterRVMap.get(playerId)
    if (oppArsenal && oppArsenal.length > 0 && batterRV && batterRV.size > 0) {
      const batterSplits: BatterVsPitchType[] = []
      for (const [pt, rv] of batterRV) batterSplits.push({ pitchType: pt, batterRV100: rv })
      arsenalZ = zArsenal(computeArsenalScore(oppArsenal, batterSplits).raw)
    }
    const present: CalibrationCoeffKey[] = []
    const fZHrPerPa = computeZHrPerPa(hrPerPa)
    if (fZHrPerPa != null) present.push('hrPerPa')
    const fZPower = computeZPower(batterInput)
    if (fZPower != null) present.push('power')
    if (arsenalZ != null) present.push('arsenal')
    const fZPark = computeZPark(parkFactor)
    if (fZPark != null) present.push('park')

    const features: NormalizedFeatures = {
      zHrPerPa: fZHrPerPa, zPower: fZPower, zArsenal: arsenalZ,
      zPark: fZPark, zHandedness: null, zWeather: null,
      zRecentForm7: 0, zRecentForm14: 0, zLineupSpot: 0,
      expectedPA: expectedPaFromLineupSlot(undefined),
      featuresPresent: present,
    }

    const out = computeGameHrProbability(features)
    const americanOdds = probToAmericanOdds(out.probability)

    results.push({
      playerId, slug: player.slug ?? '', name: player.name ?? 'Unknown',
      team: pTeam, position: player.position ?? null,
      opponentPitcher: null, opponentPitcherHand: null,
      hrProbability: out.probability, l7Hrs: null, tier: out.tier,
      opponent: matchupDisplayMap.get(pTeam) ?? null,
      americanOdds, americanOddsStr: formatAmericanOdds(americanOdds),
      source: 'hr_model',
    })
  }

  results.sort((a, b) => (b.hrProbability ?? 0) - (a.hrProbability ?? 0))
  return results
}

async function getGamesForDateRaw(supabase: SupabaseClient, dateIso: string) {
  const { data: bdl, error: bdlErr } = await supabase
    .from('bdl_games')
    .select('home_team_abbrev,away_team_abbrev,date,start_time_utc')
    .gte('date', shiftIsoDate(dateIso, -1))
    .lte('date', shiftIsoDate(dateIso, 1))
  if (!bdlErr && bdl?.length) {
    return bdl
      .filter((g: any) => {
        const etDate = utcToETDateIso(g.start_time_utc ?? null)
        return etDate ? etDate === dateIso : g.date === dateIso
      })
      .map((g: any) => ({ home_team: g.home_team_abbrev, away_team: g.away_team_abbrev })) as { home_team: string; away_team: string }[]
  }
  const { data } = await supabase
    .from('schedule_games').select('home_team,away_team').eq('date', dateIso)
  return (data ?? []) as { home_team: string; away_team: string }[]
}

/* ─── Public API ─────────────────────────────────────────────────── */

export async function listDailyHrProjections(
  supabase: SupabaseClient,
  dateIso?: string,
): Promise<DailyProjection[]> {
  const date = dateIso ?? getAppDisplayDateIso()
  const fromDaily = await listDailyHrProjectionsFromTable(supabase, date)
  if (fromDaily.length > 0 && !hasBrokenCapDistribution(fromDaily)) return fromDaily
  return calculateMatchupProjections(supabase, date)
}

export async function mergedHrProbabilityMapForDate(
  supabase: SupabaseClient,
  dateIso: string,
  playerIdsHint?: Iterable<string>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const fromDaily = await listDailyHrProjectionsFromTable(supabase, dateIso)
  const usableDaily = hasBrokenCapDistribution(fromDaily) ? [] : fromDaily
  for (const d of usableDaily) {
    if (d.hrProbability != null) out.set(d.playerId, d.hrProbability)
  }

  const hint = playerIdsHint ? new Set(playerIdsHint) : null
  const needCalc =
    !usableDaily.length ||
    (hint != null && [...hint].some((id) => !out.has(id)))
  if (!needCalc) return out

  const fromCalc = await calculateMatchupProjections(supabase, dateIso)
  for (const d of fromCalc) {
    if (!out.has(d.playerId) && d.hrProbability != null) {
      out.set(d.playerId, d.hrProbability)
    }
  }
  return out
}

export function formatProbability(p: number | null) {
  if (p == null || Number.isNaN(p)) return '—'
  return `${Math.round(p * 1000) / 10}%`
}

const TIER_ORDER = ['A+', 'A', 'B', 'C', 'D'] as const

export function groupProjectionsByTier(
  rows: DailyProjection[],
): { tierKey: string; tierLabel: string; data: DailyProjection[] }[] {
  const buckets = new Map<string, DailyProjection[]>()
  for (const r of rows) {
    const raw = (r.tier ?? '').trim().toUpperCase()
    const key = TIER_ORDER.includes(raw as (typeof TIER_ORDER)[number])
      ? raw
      : 'OTHER'
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(r)
  }

  const out: { tierKey: string; tierLabel: string; data: DailyProjection[] }[] = []
  for (const t of TIER_ORDER) {
    const data = buckets.get(t)
    if (data?.length) {
      out.push({ tierKey: t, tierLabel: `${t} Tier`, data })
    }
  }
  const other = buckets.get('OTHER')
  if (other?.length) {
    out.push({ tierKey: 'OTHER', tierLabel: 'Other', data: other })
  }
  return out
}
