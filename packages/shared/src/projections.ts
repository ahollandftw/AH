import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchMaxBattingHomerunYear } from './statsQueries'
import { getAppDisplayDateIso } from './displayDate'
import {
  calculateHrProbability,
  formatAmericanOdds,
  probToAmericanOdds,
  probToTier,
} from './hrProbability'

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
    .select('player_id, attempts, avg_hit_speed, ev95percent, brl_percent, fbld')
    .eq('role', 'batting')
    .eq('season', season)
    .limit(2000)
  return (data ?? []) as {
    player_id: string
    attempts: unknown
    avg_hit_speed: unknown
    ev95percent: unknown
    brl_percent: unknown
    fbld: unknown
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
    .select('player_id, pitch_type, slg, est_slg')
    .eq('role', 'batting')
    .eq('season', season)
    .limit(5000)
  return (data ?? []) as {
    player_id: string
    pitch_type: string
    slg: unknown
    est_slg: unknown
  }[]
}

async function fetchAllPitcherHR(supabase: SupabaseClient, year: number) {
  const { data } = await supabase
    .from('stats_homeruns')
    .select('player_id, team_abbrev, hr_total')
    .eq('role', 'pitching')
    .eq('type', 'adj_xhr')
    .eq('year', year)
    .limit(2000)
  return (data ?? []) as {
    player_id: string
    team_abbrev: string
    hr_total: unknown
  }[]
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

  for (const g of games) {
    const home = canonicalTeam(g.home_team) ?? g.home_team
    const away = canonicalTeam(g.away_team) ?? g.away_team
    teamsPlaying.add(home)
    teamsPlaying.add(away)
    opponentMap.set(home, away)
    opponentMap.set(away, home)
    matchupDisplayMap.set(home, `vs ${away}`)
    matchupDisplayMap.set(away, `@ ${home}`)
  }

  const year = await fetchMaxBattingHomerunYear(supabase)
  if (year == null) return []

  const [evRows, hrRows, bArsenalRows, pHrRows, pArsenalRows, playersRes] =
    await Promise.all([
      fetchAllBatterEV(supabase, year),
      fetchAllBatterHR(supabase, year),
      fetchAllBatterArsenal(supabase, year),
      fetchAllPitcherHR(supabase, year),
      fetchAllPitcherArsenal(supabase, year),
      supabase
        .from('players')
        .select('stat_player_id,slug,name,team,position')
        .limit(3000),
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

  const bArsenalMap = new Map<string, typeof bArsenalRows>()
  for (const r of bArsenalRows) {
    if (!bArsenalMap.has(r.player_id)) bArsenalMap.set(r.player_id, [])
    bArsenalMap.get(r.player_id)!.push(r)
  }

  // Team-level pitcher HR totals (average per pitcher on that team)
  const pitcherHrByTeam = new Map<string, number[]>()
  for (const r of pHrRows) {
    const t = canonicalTeam(r.team_abbrev) ?? r.team_abbrev
    if (!pitcherHrByTeam.has(t)) pitcherHrByTeam.set(t, [])
    pitcherHrByTeam.get(t)!.push(num(r.hr_total) ?? 0)
  }

  // Team-level pitch mix: team → pitch_type → total raw pitches
  const teamPitchCounts = new Map<string, Map<string, number>>()
  for (const r of pArsenalRows) {
    const t = canonicalTeam(r.team_name_alt) ?? r.team_name_alt
    if (!teamPitchCounts.has(t)) teamPitchCounts.set(t, new Map())
    const m = teamPitchCounts.get(t)!
    m.set(r.pitch_type, (m.get(r.pitch_type) ?? 0) + (num(r.pitches) ?? 0))
  }

  // Convert raw counts → fractions (0-1) per team
  const teamPitchUsage = new Map<string, Map<string, number>>()
  for (const [t, pitchMap] of teamPitchCounts) {
    const total = Array.from(pitchMap.values()).reduce((a, b) => a + b, 0)
    if (total <= 0) continue
    const frac = new Map<string, number>()
    for (const [pt, c] of pitchMap) frac.set(pt, c / total)
    teamPitchUsage.set(t, frac)
  }

  const results: DailyProjection[] = []

  for (const [playerId, ev] of evMap) {
    const player = playerMap.get(playerId)
    if (!player) continue
    const pTeam = canonicalTeam(player.team)
    if (!pTeam || !teamsPlaying.has(pTeam)) continue

    const oppTeam = opponentMap.get(pTeam) ?? null
    const hr = hrMap.get(playerId)

    const brl_percent = num(ev.brl_percent) ?? 0
    const ev95percent = num(ev.ev95percent) ?? 0
    const avg_hit_speed = num(ev.avg_hit_speed) ?? 0
    const fbld = num(ev.fbld) ?? 0
    const attempts = num(ev.attempts) ?? 1
    const hr_total = num(hr?.hr_total) ?? 0

    if (hr_total <= 0 && brl_percent <= 0) continue

    // Pitcher factor from opposing team
    let pitcher_hr_total = 20
    if (oppTeam) {
      const hrs = pitcherHrByTeam.get(oppTeam)
      if (hrs?.length) {
        pitcher_hr_total = hrs.reduce((a, b) => a + b, 0) / hrs.length
      }
    }

    // Matchup score: batter SLG vs each pitch weighted by opp team pitch usage
    let matchup_score = 0.4
    const bArsenal = bArsenalMap.get(playerId)
    const oppUsage = oppTeam ? teamPitchUsage.get(oppTeam) : null

    if (bArsenal?.length && oppUsage) {
      const batterSlg = new Map<string, number>()
      for (const r of bArsenal) {
        batterSlg.set(r.pitch_type, num(r.slg) ?? num(r.est_slg) ?? 0)
      }
      let weighted = 0
      for (const [pt, usage] of oppUsage) {
        weighted += (batterSlg.get(pt) ?? 0.350) * usage
      }
      if (weighted > 0) matchup_score = weighted
    }

    const result = calculateHrProbability({
      brl_percent,
      ev95percent,
      avg_hit_speed,
      fbld,
      hr_total,
      attempts,
      pitcher_hr_total,
      matchup_score,
    })

    results.push({
      playerId,
      slug: player.slug ?? '',
      name: player.name ?? 'Unknown',
      team: pTeam,
      position: player.position ?? null,
      opponentPitcher: null,
      opponentPitcherHand: null,
      hrProbability: result.probability,
      l7Hrs: null,
      tier: result.tier,
      opponent: matchupDisplayMap.get(pTeam) ?? null,
      americanOdds: result.americanOdds,
      americanOddsStr: result.americanOddsStr,
      source: 'hr_model',
    })
  }

  results.sort((a, b) => (b.hrProbability ?? 0) - (a.hrProbability ?? 0))
  return results
}

/* ─── Public API ─────────────────────────────────────────────────── */

export async function listDailyHrProjections(
  supabase: SupabaseClient,
  dateIso?: string,
): Promise<DailyProjection[]> {
  const date = dateIso ?? getAppDisplayDateIso()

  const fromDaily = await listDailyHrProjectionsFromTable(supabase, date)
  if (fromDaily.length > 0) return fromDaily

  return calculateMatchupProjections(supabase, date)
}

async function getGamesForDateRaw(supabase: SupabaseClient, dateIso: string) {
  const { data, error } = await supabase
    .from('schedule_games')
    .select('home_team,away_team')
    .eq('date', dateIso)
  if (error || !data?.length) return []
  return data as { home_team: string; away_team: string }[]
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
