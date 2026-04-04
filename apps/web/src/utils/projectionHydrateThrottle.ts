/**
 * Limits on-demand projection API hydration when Supabase has no rows yet.
 * Avoids hammering /bdl/projections/* on every navigation or refresh.
 */
const STORAGE_PREFIX = 'ah:projHydrate'
/** Minimum time between API hydrate attempts per (model, slate date). */
export const PROJECTION_HYDRATE_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour

export type ProjectionHydrateModel = 'weighted_pitch_arsenal' | 'contact_quality'

export function shouldAttemptProjectionHydrate(model: ProjectionHydrateModel, dateIso: string): boolean {
  if (typeof localStorage === 'undefined') return true
  const key = `${STORAGE_PREFIX}:${model}:${dateIso}`
  const last = Number(localStorage.getItem(key) ?? '0')
  if (!Number.isFinite(last) || last <= 0) return true
  return Date.now() - last >= PROJECTION_HYDRATE_COOLDOWN_MS
}

/** Call immediately before issuing the fetch, so failures are also throttled. */
export function recordProjectionHydrateAttempt(model: ProjectionHydrateModel, dateIso: string): void {
  if (typeof localStorage === 'undefined') return
  const key = `${STORAGE_PREFIX}:${model}:${dateIso}`
  localStorage.setItem(key, String(Date.now()))
}
