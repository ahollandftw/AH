import { LEAGUE } from './calibration.js'
import { clamp } from './normalize.js'

export interface PitchArsenalEntry {
  pitchType:     string
  usagePct:      number
  pitcherRV100:  number
  usagePctHittersCount?:  number | null
  usagePctPitchersCount?: number | null
}

export interface BatterVsPitchType {
  pitchType:    string
  batterRV100:  number
  whiffRate?:   number | null
}

export interface ArsenalMatchupDetail {
  pitchType:       string
  usagePct:        number
  pitcherRV100:    number
  batterRV100:     number
  batterAdvantage: number
  weightedContrib: number
}

/**
 * Pitch-level arsenal matchup score.
 *
 * For each pitch type the pitcher throws:
 *   batterAdvantage = batterRV100 - pitcherRV100
 * Weighted by pitch usage (adjusted for hitter's count leverage when available).
 * Summed → arsenalRaw.
 */
export function computeArsenalScore(
  pitcherPitches: PitchArsenalEntry[],
  batterSplits:   BatterVsPitchType[],
): { raw: number; detail: ArsenalMatchupDetail[] } {
  const totalUsage = pitcherPitches.reduce((s, p) => s + p.usagePct, 0)
  if (totalUsage === 0) return { raw: 0, detail: [] }

  const detail: ArsenalMatchupDetail[] = []
  let arsenalRaw = 0

  for (const pitch of pitcherPitches) {
    const rawUsageFrac = pitch.usagePct / totalUsage

    let effectiveUsageFrac = rawUsageFrac
    if (
      pitch.usagePctHittersCount != null &&
      pitch.usagePctPitchersCount != null
    ) {
      const countWeighted =
        (pitch.usagePctHittersCount * 0.60) + (pitch.usagePctPitchersCount * 0.40)
      effectiveUsageFrac = countWeighted / totalUsage
    }

    const batterSplit = batterSplits.find((b) => b.pitchType === pitch.pitchType)
    const batterRV100 = batterSplit?.batterRV100 ?? 0

    const batterAdvantage = batterRV100 - pitch.pitcherRV100
    const weightedContrib = effectiveUsageFrac * batterAdvantage
    arsenalRaw += weightedContrib

    detail.push({
      pitchType:    pitch.pitchType,
      usagePct:     pitch.usagePct,
      pitcherRV100: pitch.pitcherRV100,
      batterRV100,
      batterAdvantage,
      weightedContrib,
    })
  }

  return { raw: arsenalRaw, detail }
}

export function zArsenal(raw: number): number {
  return clamp(
    (raw - LEAGUE.arsenal.mean) / LEAGUE.arsenal.std,
    -3, 3,
  )
}

/** Fallback when no arsenal data exists — uses HR/9 as a weak proxy. */
export function zPitcherFallback(hrPer9: number | null): number | null {
  if (hrPer9 == null) return null
  return clamp((hrPer9 - LEAGUE.hrPer9.mean) / LEAGUE.hrPer9.std, -3, 3)
}
