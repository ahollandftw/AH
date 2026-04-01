import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getGamesForDate,
  listDailyHrProjections,
  type DailyProjection,
  type ScheduleGame,
} from '@kinetic/shared'
import { bdlRowMatchesCalendarDay } from './bdlCalendarDay'

export type DailyDataBundle = {
  date: string
  projections: DailyProjection[]
  weightedRows: DailyProjection[]
  games: ScheduleGame[]
  liveGames: any[]
  probablePitchers: Record<string, { home: string | null; away: string | null }>
  lineupByGame: Record<string, any | null>
  loadedAt: number
}

const bundleCache = new Map<string, DailyDataBundle>()
const bundleInFlight = new Map<string, Promise<DailyDataBundle>>()

function fetchJson<T>(url: string, fallback: T): Promise<T> {
  return fetch(url)
    .then((response) => (response.ok ? response.json() : fallback))
    .catch(() => fallback) as Promise<T>
}

export function getCachedDailyDataBundle(date: string): DailyDataBundle | null {
  return bundleCache.get(date) ?? null
}

export async function preloadDailyDataBundle(
  supabase: SupabaseClient,
  date: string,
  apiBase: string,
): Promise<DailyDataBundle> {
  const cached = bundleCache.get(date)
  if (cached) return cached
  const existing = bundleInFlight.get(date)
  if (existing) return existing

  const promise = (async () => {
    const prevDate = new Date(`${date}T12:00:00Z`)
    prevDate.setUTCDate(prevDate.getUTCDate() - 1)
    const nextDate = new Date(`${date}T12:00:00Z`)
    nextDate.setUTCDate(nextDate.getUTCDate() + 1)
    const prevIso = prevDate.toISOString().slice(0, 10)
    const nextIso = nextDate.toISOString().slice(0, 10)

    const [
      projections,
      games,
      liveRes,
      probableJsonRaw,
      lineupsJsonRaw,
      weightedJsonRaw,
    ] = await Promise.all([
      listDailyHrProjections(supabase, date),
      getGamesForDate(supabase, date),
      supabase
        .from('bdl_games')
        .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev,status,home_score,away_score,home_hits,away_hits,home_errors,away_errors,home_inning_scores,away_inning_scores,current_period,scoring_summary')
        .gte('date', prevIso)
        .lte('date', nextIso),
      apiBase
        ? fetchJson<{ data?: Record<string, { home: string | null; away: string | null }> }>(
            `${apiBase}/bdl/probable-pitchers?date=${encodeURIComponent(date)}`,
            {},
          )
        : Promise.resolve({}),
      apiBase
        ? fetchJson<{ data?: Record<string, any | null> }>(
            `${apiBase}/bdl/lineups/slate?date=${encodeURIComponent(date)}`,
            {},
          )
        : Promise.resolve({}),
      apiBase
        ? fetchJson<{ rows?: DailyProjection[] }>(
            `${apiBase}/bdl/projections/weighted?date=${encodeURIComponent(date)}`,
            {},
          )
        : Promise.resolve({}),
    ])

    const probableJson = probableJsonRaw as { data?: Record<string, { home: string | null; away: string | null }> }
    const lineupsJson = lineupsJsonRaw as { data?: Record<string, any | null> }
    const weightedJson = weightedJsonRaw as { rows?: DailyProjection[] }

    const lineupByGame: Record<string, any | null> = {}
    for (const [gameId, lineup] of Object.entries(lineupsJson?.data ?? {})) {
      lineupByGame[`game:${gameId}`] = lineup
    }

    const rawLive = (liveRes.data ?? []) as any[]
    const bundle: DailyDataBundle = {
      date,
      projections,
      weightedRows: weightedJson?.rows ?? [],
      games,
      liveGames: rawLive.filter((game) => bdlRowMatchesCalendarDay(game, date)),
      probablePitchers: probableJson?.data ?? {},
      lineupByGame,
      loadedAt: Date.now(),
    }
    bundleCache.set(date, bundle)
    bundleInFlight.delete(date)
    return bundle
  })()

  bundleInFlight.set(date, promise)
  return promise
}

export function clearDailyDataBundle(date?: string) {
  if (date) {
    bundleCache.delete(date)
    bundleInFlight.delete(date)
    return
  }
  bundleCache.clear()
  bundleInFlight.clear()
}
