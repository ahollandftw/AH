import type { SupabaseClient } from '@supabase/supabase-js'

/** Primary homeruns leaderboard row from Statcast exports. */
export const HOMERUNS_LEADERBOARD_TYPE = 'adj_xhr' as const

/**
 * Latest batting exit-velocity row for a player (by season).
 */
export async function fetchLatestBattingExitVelocity(
  supabase: SupabaseClient,
  statPlayerId: string,
) {
  const { data, error } = await supabase
    .from('stats_exit_velocity')
    .select('*')
    .eq('player_id', statPlayerId)
    .eq('role', 'batting')
    .order('season', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  return data as Record<string, unknown>
}

/**
 * Latest batting adj_xhr homeruns row (season HR expectation / totals from your CSV).
 */
export async function fetchLatestBattingHomerunsAdjXhr(
  supabase: SupabaseClient,
  statPlayerId: string,
) {
  const { data, error } = await supabase
    .from('stats_homeruns')
    .select('*')
    .eq('player_id', statPlayerId)
    .eq('role', 'batting')
    .eq('type', HOMERUNS_LEADERBOARD_TYPE)
    .order('year', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  return data as Record<string, unknown>
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * Maps imported Statcast CSV columns into Launch Lab UI fields.
 * Tune these when you add a real model; rosters/schedule can replace HR expectation later.
 */
export function mapStatsToLaunchLabProjection(
  ev: Record<string, unknown> | null,
  hr: Record<string, unknown> | null,
): {
  seasonHrProjection: number
  seasonHrVsAvg: number
  verticalLaunchVectorDegrees: number
  sweetSpotPercentage: number
  optimalHrZoneLabel: string
  consistencyScore: number
  exitVelocityMph: number
} {
  const xhr = num(hr?.xhr) ?? 50
  const xhrDiff = num(hr?.xhr_diff) ?? 0
  const avgAngle = num(ev?.avg_hit_angle) ?? 15
  const maxSpd = num(ev?.max_hit_speed) ?? num(ev?.avg_hit_speed) ?? 90
  const sweet = num(ev?.anglesweetspotpercent) ?? 0
  const ev95 = num(ev?.ev95percent) ?? 0
  const brl = num(ev?.brl_percent) ?? 0

  const lo = Math.max(8, Math.round(avgAngle - 6))
  const hi = Math.min(40, Math.round(avgAngle + 8))
  const optimalHrZoneLabel = `${lo}° - ${hi}°`

  const blend = ev95 * 0.65 + Math.min(100, brl * 3) * 0.35
  const consistencyScore = Number.isFinite(blend) && blend > 0
    ? Math.min(100, Math.round(blend))
    : Math.min(100, Math.round(sweet))

  return {
    seasonHrProjection: Math.round(xhr),
    seasonHrVsAvg: xhrDiff,
    verticalLaunchVectorDegrees: avgAngle,
    sweetSpotPercentage: sweet,
    optimalHrZoneLabel,
    consistencyScore,
    exitVelocityMph: maxSpd,
  }
}

/** Tier buckets for stats-based leaderboard until daily matchup rows exist. */
export function xhrToTier(xhr: number): string {
  if (xhr >= 55) return 'S'
  if (xhr >= 50) return 'A'
  if (xhr >= 44) return 'B'
  return 'C'
}

/** Rough 0–1 scale for % display; replace with model when schedule/rosters land. */
export function xhrToDisplayProbability(xhr: number): number {
  return Math.min(0.45, Math.max(0.06, xhr / 200))
}

export async function fetchBattingAdjXhrLeaderboard(
  supabase: SupabaseClient,
  year: number,
) {
  const { data, error } = await supabase
    .from('stats_homeruns')
    .select('player_id,xhr,xhr_diff,hr_total,year')
    .eq('role', 'batting')
    .eq('type', HOMERUNS_LEADERBOARD_TYPE)
    .eq('year', year)
    .order('xhr', { ascending: false, nullsFirst: false })

  if (error || !data?.length) return []
  return data as { player_id: string; xhr: unknown; xhr_diff: unknown; hr_total: unknown; year: number }[]
}

/**
 * Max season year present in batting homeruns stats (for leaderboard fallback).
 */
export async function fetchMaxBattingHomerunYear(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('stats_homeruns')
    .select('year')
    .eq('role', 'batting')
    .eq('type', HOMERUNS_LEADERBOARD_TYPE)
    .order('year', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || data?.year == null) return null
  return Number(data.year)
}
