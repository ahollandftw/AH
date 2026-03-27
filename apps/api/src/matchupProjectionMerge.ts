import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateMatchupProjections, listDailyHrProjectionsFromTable } from './hrModelCalc.js'

/**
 * Daily table first, then HR model for any player missing from `daily_hr_projections`.
 * Same behavior as `@kinetic/shared` `mergedHrProbabilityMapForDate` (logistic HR model).
 */
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
