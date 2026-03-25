import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchBattingAdjXhrLeaderboard,
  fetchMaxBattingHomerunYear,
  xhrToDisplayProbability,
  xhrToTier,
} from './statsQueries'
import { getAppDisplayDateIso } from './displayDate'

export type DailyProjection = {
  /** Statcast player id (matches CSV player_id). */
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
  /**
   * `daily_table` — real matchup rows for that date.
   * `stats_homeruns` — fallback from imported CSV leaderboard (xhr), filtered by schedule.
   */
  source?: 'daily_table' | 'stats_homeruns'
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
    .map((row: any) => ({
      playerId: row.players?.stat_player_id ?? row.player_id,
      slug: row.players?.slug ?? '',
      name: row.players?.name ?? 'Unknown',
      team: canonicalTeam(row.players?.team) ?? row.players?.team ?? null,
      position: row.players?.position ?? null,
      opponentPitcher: row.opponent_pitcher ?? null,
      opponentPitcherHand: row.opponent_pitcher_hand ?? null,
      hrProbability:
        typeof row.hr_probability === 'number'
          ? row.hr_probability
          : row.hr_probability != null
            ? Number(row.hr_probability)
            : null,
      l7Hrs: row.l7_hrs ?? null,
      tier: row.tier ?? null,
      opponent: null,
      source: 'daily_table' as const,
    }))
    .filter((p: DailyProjection) => p.name !== 'Unknown')
}

export async function listDailyHrProjections(
  supabase: SupabaseClient,
  dateIso?: string,
): Promise<DailyProjection[]> {
  const date = dateIso ?? getAppDisplayDateIso()

  const fromDaily = await listDailyHrProjectionsFromTable(supabase, date)
  if (fromDaily.length > 0) return fromDaily

  const [year, games] = await Promise.all([
    fetchMaxBattingHomerunYear(supabase),
    getGamesForDateRaw(supabase, date),
  ])
  if (year == null) return []

  const leaderboard = await fetchBattingAdjXhrLeaderboard(supabase, year)
  if (!leaderboard.length) return []

  const ids = [...new Set(leaderboard.map((r) => r.player_id))]
  const { data: players, error: pErr } = await supabase
    .from('players')
    .select('stat_player_id,slug,name,team,position')
    .in('stat_player_id', ids)

  if (pErr || !players?.length) return []

  const teamsPlaying = new Set<string>()
  const matchupMap = new Map<string, string>()
  for (const g of games) {
    const home = canonicalTeam(g.home_team) ?? g.home_team
    const away = canonicalTeam(g.away_team) ?? g.away_team
    teamsPlaying.add(home)
    teamsPlaying.add(away)
    matchupMap.set(home, `vs ${away}`)
    matchupMap.set(away, `@ ${home}`)
  }

  const pmap = new Map(
    (players as { stat_player_id: string; slug: string; name: string; team: string | null; position: string | null }[]).map(
      (p) => [p.stat_player_id, p],
    ),
  )

  const out: DailyProjection[] = []
  for (const row of leaderboard) {
    const p = pmap.get(row.player_id)
    if (!p) continue
    const pTeam = canonicalTeam(p.team)
    if (teamsPlaying.size > 0 && pTeam && !teamsPlaying.has(pTeam)) continue
    const xhr = num(row.xhr) ?? 0
    out.push({
      playerId: p.stat_player_id,
      slug: p.slug,
      name: p.name,
      team: pTeam ?? p.team ?? null,
      position: p.position ?? null,
      opponentPitcher: null,
      opponentPitcherHand: null,
      hrProbability: xhrToDisplayProbability(xhr),
      l7Hrs: null,
      tier: xhrToTier(xhr),
      opponent: (pTeam ? matchupMap.get(pTeam) : null) ?? null,
      source: 'stats_homeruns',
    })
  }
  return out
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

const TIER_ORDER = ['S', 'A', 'B', 'C'] as const

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
      out.push({ tierKey: t, tierLabel: `${t} tier`, data })
    }
  }
  const other = buckets.get('OTHER')
  if (other?.length) {
    out.push({ tierKey: 'OTHER', tierLabel: 'Other', data: other })
  }
  return out
}
