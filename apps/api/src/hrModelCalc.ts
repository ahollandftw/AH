/**
 * HR matchup engine — on-demand fallback when daily_hr_projections table is empty.
 * Uses the new calibrated logistic model with arsenal matchups.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchMaxBattingHomerunYear } from './statsHomerunYear.js'
import { getBallparkForHomeTeam } from './mlbBallparks.js'
import {
  computeGameHrProbability,
  probToAmericanOdds,
  formatAmericanOdds,
  probToTier,
  summarizeProjectionDistribution,
  type NormalizedFeatures,
} from './models/hr/hrProbability.js'
import { CALIBRATION, type CalibrationCoeffKey } from './models/hr/calibration.js'
import { expectedPaFromLineupSlot } from './models/hr/expectedPA.js'
import {
  computeMatchupHrRate,
  zMatchup,
  zPark as computeZPark,
  zHandedness,
  zLineupSpot,
  zRecentForm,
  type BatterFeatureInput,
} from './models/hr/features.js'

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

/* ─── daily_hr_projections table path ────────────────────────────── */

async function listDailyHrProjectionsFromTable(
  supabase: SupabaseClient,
  dateIso: string,
): Promise<DailyProjection[]> {
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
        opponent: null,
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
    .select('player_id, attempts, avg_hit_speed, ev95percent, brl_percent, fbld, gb')
    .eq('role', 'batting').eq('season', season).limit(5000)
  return (data ?? []) as any[]
}

async function fetchAllBatterHR(supabase: SupabaseClient, year: number) {
  const { data } = await supabase
    .from('stats_homeruns')
    .select('player_id, hr_total')
    .eq('role', 'batting').eq('type', 'adj_xhr').eq('year', year).limit(2000)
  return (data ?? []) as any[]
}

async function fetchAllBatterArsenal(supabase: SupabaseClient, season: number) {
  const { data } = await supabase
    .from('stats_pitch_arsenal')
    .select('player_id, pitch_type, run_value_per_100, pitch_usage, slg, est_woba, woba')
    .eq('role', 'batting').eq('season', season).limit(10000)
  return (data ?? []) as any[]
}

async function fetchAllPitcherArsenal(supabase: SupabaseClient, season: number) {
  const { data } = await supabase
    .from('stats_pitch_arsenal')
    .select('player_id, team_name_alt, pitch_type, run_value_per_100, pitch_usage')
    .eq('role', 'pitching').eq('season', season).limit(10000)
  return (data ?? []) as any[]
}

async function fetchAllStandardBatting(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('stats_standard')
    .select('player_id,team_abbrev,pa,hr')
    .eq('role', 'batting')
    .limit(10000)
  if (error) return [] as any[]
  return (data ?? []) as any[]
}

async function fetchAllStandardPitching(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('stats_standard')
    .select('player_id,team_abbrev,tbf,hr')
    .eq('role', 'pitching')
    .limit(10000)
  if (error) return [] as any[]
  return (data ?? []) as any[]
}

async function fetchAllPitcherHR(supabase: SupabaseClient, year: number) {
  const { data } = await supabase
    .from('stats_homeruns')
    .select('player_id, team_abbrev, hr_total, xhr')
    .eq('role', 'pitching').eq('type', 'adj_xhr').eq('year', year).limit(5000)
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

function metricBb(m: Record<string, unknown> | undefined, key: string): number | null {
  if (!m) return null
  return num(m[key])
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

/* ─── Matchup-based projection engine ────────────────────────────── */

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

  const [bbRows, parkRows, playersRes, standardBattingRows, standardPitchingRows] =
    await Promise.all([
      fetchBattedBallBatting(supabase),
      fetchParkFactors(supabase),
      supabase.from('players').select('stat_player_id,slug,name,team,position').limit(5000),
      fetchAllStandardBatting(supabase),
      fetchAllStandardPitching(supabase),
    ])

  const players = (playersRes.data ?? []) as any[]
  const playerMap = new Map(players.map((p: any) => [p.stat_player_id, p]))
  const venueLower = buildVenueParkMap(parkRows)

  const bbByPlayer = new Map<string, { lhp?: Record<string, unknown>; rhp?: Record<string, unknown> }>()
  for (const row of bbRows) {
    if (!bbByPlayer.has(row.player_id)) bbByPlayer.set(row.player_id, {})
    const b = bbByPlayer.get(row.player_id)!
    if (row.split === 'vs_lhp') b.lhp = row.metrics
    if (row.split === 'vs_rhp') b.rhp = row.metrics
  }

  const standardBattingMap = new Map<string, { pa: number | null; hr: number | null }>()
  for (const row of standardBattingRows as any[]) {
    const pid = String(row.player_id ?? '')
    if (!pid || standardBattingMap.has(pid)) continue
    standardBattingMap.set(pid, { pa: row.pa ?? null, hr: row.hr ?? null })
  }
  const teamPitchingBuckets = new Map<string, { hr: number; tbf: number }>()
  for (const row of standardPitchingRows as any[]) {
    const team = canonicalTeam(row.team_abbrev) ?? row.team_abbrev
    const tbf = num(row.tbf) ?? 0
    const hr = num(row.hr) ?? 0
    if (!team || tbf <= 0) continue
    if (!teamPitchingBuckets.has(team)) teamPitchingBuckets.set(team, { hr: 0, tbf: 0 })
    const acc = teamPitchingBuckets.get(team)!
    acc.hr += hr
    acc.tbf += tbf
  }
  const teamPitcherHrPerPaAllowed = new Map<string, number>()
  for (const [team, acc] of teamPitchingBuckets) {
    if (acc.tbf > 0) teamPitcherHrPerPaAllowed.set(team, acc.hr / acc.tbf)
  }

  const results: DailyProjection[] = []
  const debugRows: Array<{ matchupHrRate: number | null; zMatchup: number | null; x: number; pPa: number; lambda: number; probRaw: number }> = []

  for (const [playerId, standardBatting] of standardBattingMap) {
    const player = playerMap.get(playerId) as any
    if (!player) continue
    const pTeam = canonicalTeam(player.team)
    if (!pTeam || !teamsPlaying.has(pTeam)) continue

    const oppTeam = opponentMap.get(pTeam) ?? null
    const attempts = num(standardBatting.pa) ?? 0
    const hrTotal = num(standardBatting.hr) ?? 0
    if (attempts <= 0) continue

    const hrPerPa = hrTotal / attempts
    if (!Number.isFinite(hrPerPa) || hrPerPa <= 0) continue

    const ha = homeAway.get(pTeam) ?? null
    const parkTeam = ha === 'H' ? pTeam : oppTeam
    const parkFactor = lookupParkFactorForHomeTeam(parkTeam, venueLower)

    const batterInput: BatterFeatureInput = {
      hrPerPa,
      hand: 'R',
      lineupPosition: null,
    }

    const present: CalibrationCoeffKey[] = []
    const matchupHrRate = computeMatchupHrRate(
      hrPerPa,
      oppTeam ? (teamPitcherHrPerPaAllowed.get(oppTeam) ?? CALIBRATION.leagueAvgHrPerPa) : CALIBRATION.leagueAvgHrPerPa,
    )
    const fZMatchup = zMatchup(matchupHrRate)
    if (fZMatchup != null) present.push('matchup')
    const fZPark = computeZPark(parkFactor)
    if (fZPark != null) present.push('park')
    const fZHand = zHandedness(batterInput, null)
    if (fZHand != null) present.push('handedness')
    const fZRecent = zRecentForm(null, null, null, null)
    if (fZRecent != null) present.push('recentForm')
    const fZLineup = zLineupSpot(null)

    const features: NormalizedFeatures = {
      zMatchup:      fZMatchup,
      zPark:         fZPark,
      zHandedness:   fZHand,
      zWeather:      null,
      zRecentForm:   fZRecent,
      zLineupSpot:   fZLineup,
      expectedPA:    expectedPaFromLineupSlot(undefined),
      matchupHrRate,
      featuresPresent: present,
    }

    const out = computeGameHrProbability(features)
    const americanOdds = probToAmericanOdds(out.probability)
    debugRows.push({ matchupHrRate, zMatchup: fZMatchup, x: out.x, pPa: out.pPa, lambda: out.lambda, probRaw: out.probRaw })

    results.push({
      playerId,
      slug: player.slug ?? '',
      name: player.name ?? 'Unknown',
      team: pTeam,
      position: player.position ?? null,
      opponentPitcher: null,
      opponentPitcherHand: null,
      hrProbability: out.probability,
      l7Hrs: null,
      tier: out.tier,
      opponent: matchupDisplayMap.get(pTeam) ?? null,
      americanOdds,
      americanOddsStr: formatAmericanOdds(americanOdds),
      source: 'hr_model',
    })
  }

  results.sort((a, b) => (b.hrProbability ?? 0) - (a.hrProbability ?? 0))
  console.log('[hr-model-calc] Distribution:', JSON.stringify(summarizeProjectionDistribution(debugRows)))
  return results
}

async function getGamesForDateRaw(supabase: SupabaseClient, dateIso: string) {
  const { data: bdl, error: bdlErr } = await supabase
    .from('bdl_games')
    .select('home_team_abbrev,away_team_abbrev')
    .eq('date', dateIso)
  if (!bdlErr && bdl?.length) {
    return bdl.map((g) => ({ home_team: g.home_team_abbrev, away_team: g.away_team_abbrev })) as { home_team: string; away_team: string }[]
  }
  const { data } = await supabase
    .from('schedule_games')
    .select('home_team,away_team')
    .eq('date', dateIso)
  return (data ?? []) as { home_team: string; away_team: string }[]
}

export { calculateMatchupProjections, listDailyHrProjectionsFromTable }
