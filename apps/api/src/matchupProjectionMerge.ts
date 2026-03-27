/**
 * Mirrors `packages/shared` matchup projection merge so the API can compile without
 * pulling `@kinetic/shared` into NodeNext (extensionless import resolution).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateHrProbability } from './hrProbability.js'

type DailyProjectionRow = {
  playerId: string
  hrProbability: number | null
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

async function fetchMaxBattingHomerunYear(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('stats_homeruns')
    .select('year')
    .eq('role', 'batting')
    .eq('type', 'adj_xhr')
    .order('year', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || data?.year == null) return null
  return Number(data.year)
}

async function listDailyHrProjectionsFromTable(
  supabase: SupabaseClient,
  dateIso: string,
): Promise<DailyProjectionRow[]> {
  const { data, error } = await supabase
    .from('daily_hr_projections')
    .select('player_id, hr_probability')
    .eq('date', dateIso)
    .order('hr_probability', { ascending: false, nullsFirst: false })

  if (error || !data) return []

  return data
    .map((row: any) => {
      const p = row.hr_probability != null ? Number(row.hr_probability) : null
      const prob = p != null && Number.isFinite(p) ? p : null
      const id = String(row.player_id ?? '')
      return { playerId: id, hrProbability: prob }
    })
    .filter((r) => r.playerId && r.playerId !== 'undefined')
}

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

async function calculateMatchupProjections(
  supabase: SupabaseClient,
  dateIso: string,
): Promise<DailyProjectionRow[]> {
  const games = await getGamesForDateRaw(supabase, dateIso)
  if (!games.length) return []

  const teamsPlaying = new Set<string>()
  const opponentMap = new Map<string, string>()

  for (const g of games) {
    const home = canonicalTeam(g.home_team) ?? g.home_team
    const away = canonicalTeam(g.away_team) ?? g.away_team
    teamsPlaying.add(home)
    teamsPlaying.add(away)
    opponentMap.set(home, away)
    opponentMap.set(away, home)
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

  const pitcherHrByTeam = new Map<string, number[]>()
  for (const r of pHrRows) {
    const t = canonicalTeam(r.team_abbrev) ?? r.team_abbrev
    if (!pitcherHrByTeam.has(t)) pitcherHrByTeam.set(t, [])
    pitcherHrByTeam.get(t)!.push(num(r.hr_total) ?? 0)
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

  const results: DailyProjectionRow[] = []

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

    let pitcher_hr_total = 20
    if (oppTeam) {
      const hrs = pitcherHrByTeam.get(oppTeam)
      if (hrs?.length) {
        pitcher_hr_total = hrs.reduce((a, b) => a + b, 0) / hrs.length
      }
    }

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
      hrProbability: result.probability,
    })
  }

  return results
}

export async function mergedHrProbabilityMapForDate(
  supabase: SupabaseClient,
  dateIso: string,
  playerIdsHint?: Iterable<string>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const fromDaily = await listDailyHrProjectionsFromTable(supabase, dateIso)
  for (const d of fromDaily) {
    if (d.hrProbability != null) out.set(d.playerId, d.hrProbability)
  }

  const hint = playerIdsHint ? new Set(playerIdsHint) : null
  const needCalc =
    !fromDaily.length ||
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
