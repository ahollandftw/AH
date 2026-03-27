/**
 * HR matchup engine (logistic + z-scores). Kept in sync with
 * `packages/shared/src/projections.ts` — update both when changing the model.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchMaxBattingHomerunYear } from './statsHomerunYear.js'
import { getBallparkForHomeTeam } from './mlbBallparks.js'
import { computeGameHrProbability } from './models/hr/hrProbability.js'
import { expectedPaFromLineupSlot } from './models/hr/expectedPA.js'
import { meanStd, zScore } from './models/hr/normalize.js'
import {
  combinePitcherZ,
  combinePowerZ,
  type RawBatterPowerParts,
  type RawPitcherParts,
} from './models/hr/features.js'

function probToAmericanOdds(prob: number): number {
  if (prob <= 0) return 9999
  if (prob >= 1) return -9999
  if (prob >= 0.5) return Math.round(-(prob / (1 - prob)) * 100)
  return Math.round(((1 - prob) / prob) * 100)
}

function formatAmericanOdds(odds: number): string {
  return odds >= 0 ? `+${odds}` : `${odds}`
}

function probToTier(prob: number): string {
  const pct = prob * 100
  if (pct >= 25) return 'A+'
  if (pct >= 20) return 'A'
  if (pct >= 15) return 'B'
  if (pct >= 10) return 'C'
  return 'D'
}

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
    .eq('role', 'batting')
    .eq('season', season)
    .limit(5000)
  return (data ?? []) as {
    player_id: string
    attempts: unknown
    avg_hit_speed: unknown
    ev95percent: unknown
    brl_percent: unknown
    fbld: unknown
    gb: unknown
  }[]
}

async function fetchAllBatterHR(supabase: SupabaseClient, year: number) {
  const { data } = await supabase
    .from('stats_homeruns')
    .select('player_id, hr_total')
    .eq('role', 'batting')
    .eq('type', 'adj_xhr')
    .eq('year', year)
    .limit(2000)
  return (data ?? []) as { player_id: string; hr_total: unknown }[]
}

async function fetchAllBatterArsenal(supabase: SupabaseClient, season: number) {
  const { data } = await supabase
    .from('stats_pitch_arsenal')
    .select('player_id, pitch_type, slg, est_slg, est_woba, woba')
    .eq('role', 'batting')
    .eq('season', season)
    .limit(8000)
  return (data ?? []) as {
    player_id: string
    pitch_type: string
    slg: unknown
    est_slg: unknown
    est_woba: unknown
    woba: unknown
  }[]
}

async function fetchAllPitcherHR(supabase: SupabaseClient, year: number) {
  const { data } = await supabase
    .from('stats_homeruns')
    .select('player_id, team_abbrev, hr_total, xhr')
    .eq('role', 'pitching')
    .eq('type', 'adj_xhr')
    .eq('year', year)
    .limit(5000)
  return (data ?? []) as {
    player_id: string
    team_abbrev: string
    hr_total: unknown
    xhr: unknown
  }[]
}

async function fetchPitcherExitVelocity(supabase: SupabaseClient, season: number) {
  const { data } = await supabase
    .from('stats_exit_velocity')
    .select('player_id, brl_percent, fbld, gb')
    .eq('role', 'pitching')
    .eq('season', season)
    .limit(5000)
  return (data ?? []) as {
    player_id: string
    brl_percent: unknown
    fbld: unknown
    gb: unknown
  }[]
}

type BattedBallRow = {
  player_id: string
  split: string
  metrics: Record<string, unknown>
}

async function fetchBattedBallBatting(supabase: SupabaseClient) {
  const { data } = await supabase
    .from('stats_batted_ball')
    .select('player_id, split, metrics')
    .eq('role', 'batting')
    .in('split', ['vs_lhp', 'vs_rhp'])
    .limit(20000)
  return (data ?? []) as BattedBallRow[]
}

async function fetchParkFactors(supabase: SupabaseClient) {
  const { data } = await supabase
    .from('stats_park_factors')
    .select('scope, venue, year_label, park_factor')
    .eq('scope', 'overall')
    .limit(500)
  return (data ?? []) as { scope: string; venue: string; year_label: string; park_factor: number | null }[]
}

async function fetchAllPitcherArsenal(supabase: SupabaseClient, season: number) {
  const { data } = await supabase
    .from('stats_pitch_arsenal')
    .select('player_id, team_name_alt, pitch_type, pitches')
    .eq('role', 'pitching')
    .eq('season', season)
    .limit(5000)
  return (data ?? []) as {
    player_id: string
    team_name_alt: string
    pitch_type: string
    pitches: unknown
  }[]
}

/* ─── Matchup-based projection engine (logistic + z-scores) ─────── */

function metricBb(m: Record<string, unknown> | undefined, key: string): number | null {
  if (!m) return null
  return num(m[key])
}

function buildVenueParkMap(
  rows: { venue: string; year_label: string; park_factor: number | null }[],
): Map<string, number> {
  const best = new Map<string, { y: string; pf: number }>()
  for (const r of rows) {
    const prev = best.get(r.venue)
    const pf = r.park_factor ?? 100
    if (!prev || r.year_label > prev.y) best.set(r.venue, { y: r.year_label, pf })
  }
  const lower = new Map<string, number>()
  for (const [venue, v] of best) {
    lower.set(venue.toLowerCase().trim(), v.pf)
  }
  return lower
}

function lookupParkFactorForHomeTeam(
  homeTeamAbbrev: string | null,
  venueLower: Map<string, number>,
): number | null {
  const bp = getBallparkForHomeTeam(homeTeamAbbrev)
  if (!bp) return null
  const s = bp.stadium.toLowerCase()
  if (venueLower.has(s)) return venueLower.get(s)!
  for (const [k, v] of venueLower) {
    if (k.includes(s) || s.includes(k)) return v
  }
  return null
}

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
    teamsPlaying.add(home)
    teamsPlaying.add(away)
    opponentMap.set(home, away)
    opponentMap.set(away, home)
    matchupDisplayMap.set(home, `vs ${away}`)
    matchupDisplayMap.set(away, `@ ${home}`)
    homeAway.set(home, 'H')
    homeAway.set(away, 'A')
  }

  const year = await fetchMaxBattingHomerunYear(supabase)
  if (year == null) return []

  const [
    evRows,
    hrRows,
    bArsenalRows,
    pHrRows,
    pArsenalRows,
    pEvRows,
    bbRows,
    parkRows,
    playersRes,
  ] = await Promise.all([
    fetchAllBatterEV(supabase, year),
    fetchAllBatterHR(supabase, year),
    fetchAllBatterArsenal(supabase, year),
    fetchAllPitcherHR(supabase, year),
    fetchAllPitcherArsenal(supabase, year),
    fetchPitcherExitVelocity(supabase, year),
    fetchBattedBallBatting(supabase),
    fetchParkFactors(supabase),
    supabase.from('players').select('stat_player_id,slug,name,team,position').limit(5000),
  ])

  const players = (playersRes.data ?? []) as {
    stat_player_id: string
    slug: string
    name: string
    team: string | null
    position: string | null
  }[]

  const evMap = new Map(evRows.map((r) => [r.player_id, r]))
  const hrMap = new Map(hrRows.map((r) => [r.player_id, r]))
  const playerMap = new Map(players.map((p) => [p.stat_player_id, p]))
  const pEvMap = new Map(pEvRows.map((r) => [r.player_id, r]))
  const venueLower = buildVenueParkMap(parkRows)

  const bbByPlayer = new Map<string, { lhp?: Record<string, unknown>; rhp?: Record<string, unknown> }>()
  for (const row of bbRows) {
    if (!bbByPlayer.has(row.player_id)) bbByPlayer.set(row.player_id, {})
    const b = bbByPlayer.get(row.player_id)!
    if (row.split === 'vs_lhp') b.lhp = row.metrics
    if (row.split === 'vs_rhp') b.rhp = row.metrics
  }

  const bArsenalMap = new Map<string, typeof bArsenalRows>()
  for (const r of bArsenalRows) {
    if (!bArsenalMap.has(r.player_id)) bArsenalMap.set(r.player_id, [])
    bArsenalMap.get(r.player_id)!.push(r)
  }

  const leagueEstWobaByPitch = new Map<string, number[]>()
  for (const r of bArsenalRows) {
    const m = num(r.est_woba) ?? num(r.woba)
    if (m == null) continue
    if (!leagueEstWobaByPitch.has(r.pitch_type)) leagueEstWobaByPitch.set(r.pitch_type, [])
    leagueEstWobaByPitch.get(r.pitch_type)!.push(m)
  }
  const leagueAvgWobaPitch = new Map<string, number>()
  for (const [pt, arr] of leagueEstWobaByPitch) {
    const ms = meanStd(arr)
    if (ms) leagueAvgWobaPitch.set(pt, ms.mean)
  }

  const teamPitchCounts = new Map<string, Map<string, number>>()
  for (const r of pArsenalRows) {
    const t = canonicalTeam(r.team_name_alt) ?? r.team_name_alt
    if (!teamPitchCounts.has(t)) teamPitchCounts.set(t, new Map())
    const m = teamPitchCounts.get(t)!
    m.set(r.pitch_type, (m.get(r.pitch_type) ?? 0) + (num(r.pitches) ?? 0))
  }

  const teamPitchUsage = new Map<string, Map<string, number>>()
  for (const [t, pitchMap] of teamPitchCounts) {
    const total = Array.from(pitchMap.values()).reduce((a, b) => a + b, 0)
    if (total <= 0) continue
    const frac = new Map<string, number>()
    for (const [pt, c] of pitchMap) frac.set(pt, c / total)
    teamPitchUsage.set(t, frac)
  }

  const pitchersByTeam = new Map<string, string[]>()
  const pHrById = new Map(pHrRows.map((r) => [r.player_id, r]))
  for (const r of pHrRows) {
    const t = canonicalTeam(r.team_abbrev) ?? r.team_abbrev
    if (!pitchersByTeam.has(t)) pitchersByTeam.set(t, [])
    pitchersByTeam.get(t)!.push(r.player_id)
  }

  function teamPitcherRaw(team: string | null): RawPitcherParts | null {
    if (!team) return null
    const ids = pitchersByTeam.get(team)
    if (!ids?.length) return null
    const xhrs: number[] = []
    const brls: number[] = []
    const fbs: number[] = []
    const gbs: number[] = []
    for (const id of ids) {
      const h = pHrById.get(id)
      const ev = pEvMap.get(id)
      const xh = num(h?.xhr)
      if (xh != null) xhrs.push(xh)
      const br = num(ev?.brl_percent)
      if (br != null) brls.push(br)
      const fb = num(ev?.fbld)
      if (fb != null) fbs.push(fb)
      const gb = num(ev?.gb)
      if (gb != null) gbs.push(gb)
    }
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
    return {
      hrProxy: avg(xhrs),
      barrelAllowed: avg(brls),
      flyBallAllowed: avg(fbs),
      groundBallRate: avg(gbs),
    }
  }

  const perPitcherParts: RawPitcherParts[] = pHrRows.map((r) => {
    const ev = pEvMap.get(r.player_id)
    return {
      hrProxy: num(r.xhr),
      barrelAllowed: num(ev?.brl_percent),
      flyBallAllowed: num(ev?.fbld),
      groundBallRate: num(ev?.gb),
    }
  })

  const nz = (xs: (number | null | undefined)[]) =>
    xs.filter((x): x is number => x != null && Number.isFinite(x))

  const leaguePitch = {
    hrProxy: meanStd(nz(perPitcherParts.map((p) => p.hrProxy))) ?? { mean: 0, std: 1 },
    barrel: meanStd(nz(perPitcherParts.map((p) => p.barrelAllowed))) ?? { mean: 0, std: 1 },
    flyBall: meanStd(nz(perPitcherParts.map((p) => p.flyBallAllowed))) ?? { mean: 0, std: 1 },
    groundBall: meanStd(nz(perPitcherParts.map((p) => p.groundBallRate))) ?? { mean: 0, std: 1 },
  }

  type Cand = {
    playerId: string
    pTeam: string
    hrPerPa: number
    powerRaw: RawBatterPowerParts
    matchupRaw: number | null
    parkFactor: number | null
    zHand: number | null
    oppTeam: string | null
    name: string
    slug: string
    position: string | null
  }

  const candidates: Cand[] = []

  for (const [playerId, ev] of evMap) {
    const player = playerMap.get(playerId)
    if (!player) continue
    const pTeam = canonicalTeam(player.team)
    if (!pTeam || !teamsPlaying.has(pTeam)) continue

    const oppTeam = opponentMap.get(pTeam) ?? null
    const hr = hrMap.get(playerId)
    const attempts = num(ev.attempts) ?? 0
    const hr_total = num(hr?.hr_total) ?? 0
    const brl_percent = num(ev.brl_percent) ?? 0

    if (hr_total <= 0 && brl_percent <= 0) continue

    const hrPerPa = attempts > 0 ? hr_total / attempts : null
    if (hrPerPa == null) {
      console.warn(`[hr-model] ${player.name ?? playerId}: missing hr_per_pa (attempts or hr_total)`)
      continue
    }

    const bb = bbByPlayer.get(playerId)
    const mL = bb?.lhp
    const mR = bb?.rhp
    const fbPct =
      mL && mR
        ? ((metricBb(mL, 'FB%') ?? 0) + (metricBb(mR, 'FB%') ?? 0)) / 2
        : metricBb(mL ?? mR, 'FB%')
    const hrFb =
      mL && mR
        ? ((metricBb(mL, 'HR/FB') ?? 0) + (metricBb(mR, 'HR/FB') ?? 0)) / 2
        : metricBb(mL ?? mR, 'HR/FB')

    if (fbPct == null) console.warn(`[hr-model] ${player.name ?? playerId}: missing batted_ball FB%`)
    if (hrFb == null) console.warn(`[hr-model] ${player.name ?? playerId}: missing batted_ball HR/FB`)

    const powerRaw: RawBatterPowerParts = {
      barrelRate: num(ev.brl_percent),
      ev95: num(ev.ev95percent),
      avgHitSpeed: num(ev.avg_hit_speed),
      flyBallRate: fbPct,
      hrPerFb: hrFb,
    }

    let matchupRaw: number | null = null
    const bArsenal = bArsenalMap.get(playerId)
    const oppUsage = oppTeam ? teamPitchUsage.get(oppTeam) : null
    if (bArsenal?.length && oppUsage) {
      const batterWoba = new Map<string, number>()
      for (const r of bArsenal) {
        const w = num(r.est_woba) ?? num(r.woba)
        if (w != null) batterWoba.set(r.pitch_type, w)
      }
      let covered = 0
      for (const [pt, usage] of oppUsage) {
        if (batterWoba.has(pt)) covered += usage
      }
      if (covered > 1e-6) {
        let acc = 0
        for (const [pt, usage] of oppUsage) {
          const bw = batterWoba.get(pt)
          const lg = leagueAvgWobaPitch.get(pt)
          if (bw == null || lg == null) continue
          acc += (usage / covered) * (bw - lg)
        }
        matchupRaw = acc
      } else {
        console.warn(`[hr-model] ${player.name ?? playerId}: matchup skipped (no overlap with opponent pitch mix)`)
      }
    } else {
      console.warn(`[hr-model] ${player.name ?? playerId}: matchup skipped (arsenal or opponent usage)`)
    }

    const ha = homeAway.get(pTeam) ?? null
    const parkTeam = ha === 'H' ? pTeam : oppTeam
    const parkFactor = lookupParkFactorForHomeTeam(parkTeam, venueLower)
    if (parkFactor == null) {
      console.warn(`[hr-model] ${player.name ?? playerId}: park factor not found for ${parkTeam}`)
    }

    let zHand: number | null = null
    const hrl = metricBb(mL, 'HR/FB')
    const hrr = metricBb(mR, 'HR/FB')
    if (hrl != null && hrr != null) {
      const platoon = Math.abs(hrl - hrr)
      zHand = platoon
    }

    candidates.push({
      playerId,
      pTeam,
      hrPerPa,
      powerRaw,
      matchupRaw,
      parkFactor,
      zHand,
      oppTeam,
      name: player.name ?? 'Unknown',
      slug: player.slug ?? '',
      position: player.position ?? null,
    })
  }

  const hrPas = candidates.map((c) => c.hrPerPa)
  const matchupRaws = candidates.map((c) => c.matchupRaw).filter((x): x is number => x != null)
  const parkVals = candidates.map((c) => c.parkFactor).filter((x): x is number => x != null)
  const platoonVals = candidates.map((c) => c.zHand).filter((x): x is number => x != null)

  const leagueHrPa = meanStd(hrPas) ?? { mean: 0, std: 1 }
  const leagueMatchup = meanStd(matchupRaws) ?? { mean: 0, std: 1 }
  const leaguePark = meanStd(parkVals) ?? { mean: 100, std: 1 }
  const leaguePlatoon =
    platoonVals.length >= 2 ? meanStd(platoonVals) ?? { mean: 0, std: 1 } : null

  const powerLeagueBase = {
    barrel: meanStd(candidates.map((c) => c.powerRaw.barrelRate).filter((x): x is number => x != null)) ?? {
      mean: 0,
      std: 1,
    },
    ev95: meanStd(candidates.map((c) => c.powerRaw.ev95).filter((x): x is number => x != null)) ?? {
      mean: 0,
      std: 1,
    },
    avgHit: meanStd(candidates.map((c) => c.powerRaw.avgHitSpeed).filter((x): x is number => x != null)) ?? {
      mean: 0,
      std: 1,
    },
    flyBall: meanStd(candidates.map((c) => c.powerRaw.flyBallRate).filter((x): x is number => x != null)) ?? {
      mean: 0,
      std: 1,
    },
    hrPerFb: meanStd(candidates.map((c) => c.powerRaw.hrPerFb).filter((x): x is number => x != null)) ?? {
      mean: 0,
      std: 1,
    },
  }

  const results: DailyProjection[] = []

  for (const c of candidates) {
    const zHrPerPa = zScore(c.hrPerPa, leagueHrPa.mean, leagueHrPa.std)
    const zPower = combinePowerZ(c.powerRaw, powerLeagueBase)
    const oppPitch = teamPitcherRaw(c.oppTeam)
    const zPitcher = oppPitch ? combinePitcherZ(oppPitch, leaguePitch) : null
    if (zPitcher == null) {
      console.warn(`[hr-model] ${c.name}: missing opponent pitching composite`)
    }

    const zMatchup =
      c.matchupRaw != null ? zScore(c.matchupRaw, leagueMatchup.mean, leagueMatchup.std) : null
    const zPark =
      c.parkFactor != null ? zScore(c.parkFactor, leaguePark.mean, leaguePark.std) : null
    const zHandedness =
      c.zHand != null && leaguePlatoon
        ? zScore(c.zHand, leaguePlatoon.mean, leaguePlatoon.std)
        : null

    const out = computeGameHrProbability({
      features: {
        zHrPerPa,
        zPower,
        zPitcher,
        zMatchup,
        zPark,
        zHandedness,
        zWeather: null,
      },
      expectedPa: expectedPaFromLineupSlot(undefined),
      playerLabel: c.name,
    })

    const americanOdds = probToAmericanOdds(out.probability)

    results.push({
      playerId: c.playerId,
      slug: c.slug,
      name: c.name,
      team: c.pTeam,
      position: c.position,
      opponentPitcher: null,
      opponentPitcherHand: null,
      hrProbability: out.probability,
      l7Hrs: null,
      tier: out.tier,
      opponent: matchupDisplayMap.get(c.pTeam) ?? null,
      americanOdds,
      americanOddsStr: formatAmericanOdds(americanOdds),
      source: 'hr_model',
    })
  }

  results.sort((a, b) => (b.hrProbability ?? 0) - (a.hrProbability ?? 0))
  return results
}

async function getGamesForDateRaw(supabase: SupabaseClient, dateIso: string) {
  const { data: bdl, error: bdlErr } = await supabase
    .from('bdl_games')
    .select('home_team_abbrev,away_team_abbrev')
    .eq('date', dateIso)
  if (!bdlErr && bdl?.length) {
    return bdl.map((g) => ({
      home_team: g.home_team_abbrev,
      away_team: g.away_team_abbrev,
    })) as { home_team: string; away_team: string }[]
  }
  const { data, error } = await supabase
    .from('schedule_games')
    .select('home_team,away_team')
    .eq('date', dateIso)
  if (error || !data?.length) return []
  return data as { home_team: string; away_team: string }[]
}

export { calculateMatchupProjections, listDailyHrProjectionsFromTable }
