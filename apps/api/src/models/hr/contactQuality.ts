import { CALIBRATION, LEAGUE } from './calibration.js'
import { zLineupSpot, type BatterFeatureInput, type Hand } from './features.js'
import { zScore } from './normalize.js'
import {
  applyCapAndFloor,
  assignTier,
  perPaProbability,
  poissonGameHrProbability,
} from './hrProbability.js'

/** z with missing → 0 (league average in z-space). */
function zOrZero(value: number | null | undefined, mean: number, std: number): number {
  return zScore(value, mean, std) ?? 0
}

/**
 * Batter power composite (Statcast-style). Missing components contribute 0 to the weighted sum.
 */
export function zPowerContactQuality(input: {
  barrelDec: number | null
  avgEv: number | null
  hardHitDec: number | null
  sweetSpotDec: number | null
}): number {
  const zb = zOrZero(input.barrelDec, LEAGUE.barrelRate.mean, LEAGUE.barrelRate.std)
  const ze = zOrZero(input.avgEv, LEAGUE.avgExitVelo.mean, LEAGUE.avgExitVelo.std)
  const zh = zOrZero(input.hardHitDec, LEAGUE.hardHitRate.mean, LEAGUE.hardHitRate.std)
  const zs = zOrZero(input.sweetSpotDec, LEAGUE.sweetSpotRate.mean, LEAGUE.sweetSpotRate.std)
  return zb * 0.4 + ze * 0.25 + zh * 0.2 + zs * 0.15
}

export function zLaunchContactQuality(flyBallDec: number | null, pullDec: number | null): number {
  const zf = zOrZero(flyBallDec, LEAGUE.flyBallRate.mean, LEAGUE.flyBallRate.std)
  const zp = zOrZero(pullDec, LEAGUE.pullRate.mean, LEAGUE.pullRate.std)
  return zf * 0.7 + zp * 0.3
}

/**
 * Pitcher damage allowed vs league (same means as batter-side Statcast metrics).
 * Spec: (-z(barrelAllowed))*0.5 + (-z(hhAllowed))*0.3 + (-z(evAllowed))*0.2
 */
export function zPitcherSuppressionContactQuality(input: {
  barrelAllowedDec: number | null
  hardHitAllowedDec: number | null
  evAllowed: number | null
}): number {
  const zb = zOrZero(input.barrelAllowedDec, LEAGUE.barrelRate.mean, LEAGUE.barrelRate.std)
  const zh = zOrZero(input.hardHitAllowedDec, LEAGUE.hardHitRate.mean, LEAGUE.hardHitRate.std)
  const ze = zOrZero(input.evAllowed, LEAGUE.avgExitVelo.mean, LEAGUE.avgExitVelo.std)
  return -zb * 0.5 - zh * 0.3 - ze * 0.2
}

export function zSkillContactQuality(input: {
  zPower: number
  zLaunch: number
  zContact: number
  zPitcherSuppression: number
}): number {
  return (
    input.zPower * 0.45 +
    input.zLaunch * 0.25 +
    input.zContact * 0.15 +
    input.zPitcherSuppression * 0.15
  )
}

/**
 * Logistic linear score: intercept from league HR/PA + skill/context z terms.
 */
export function contactQualityLinearScore(input: {
  zSkill: number
  zPark: number
  zWeather: number
  zHandedness: number
  zLineupSpot: number
}): number {
  const b = Math.log(CALIBRATION.leagueAvgHrPerPa / (1 - CALIBRATION.leagueAvgHrPerPa))
  return (
    b +
    input.zSkill * 1.2 +
    input.zPark * 0.25 +
    input.zWeather * 0.15 +
    input.zHandedness * 0.15 +
    input.zLineupSpot * 0.1
  )
}

/** Normalize lineup spot adjustment to ~z-scale for the linear layer. */
export function zLineupSpotForContactQuality(lineupPosition: number | null): number {
  const raw = zLineupSpot(lineupPosition)
  return zScore(raw, 0, 0.35) ?? 0
}

/**
 * Handedness z for contact-quality model: HR/PA split vs same-handed pitcher when available;
 * otherwise platoon grid from `features.zHandedness`, z-scored to match other context terms.
 */
export function contactQualityZHandedness(
  batter: BatterFeatureInput,
  pitcherHand: Hand | null,
): number {
  if (!pitcherHand) return 0
  if (pitcherHand === 'L' && batter.hrPerPaVsL != null) {
    return zScore(batter.hrPerPaVsL, LEAGUE.hrPerPa.mean, LEAGUE.hrPerPa.std) ?? 0
  }
  if (pitcherHand === 'R' && batter.hrPerPaVsR != null) {
    return zScore(batter.hrPerPaVsR, LEAGUE.hrPerPa.mean, LEAGUE.hrPerPa.std) ?? 0
  }
  const effectiveHand: Hand =
    batter.hand === 'S' ? (pitcherHand === 'L' ? 'R' : 'L') : batter.hand
  const platoonAdj: Record<string, number> = {
    R_L: 0.8,
    L_R: 0.5,
    R_R: -0.35,
    L_L: -0.45,
  }
  const raw = platoonAdj[`${effectiveHand}_${pitcherHand}`] ?? 0
  return zScore(raw, 0, 0.35) ?? 0
}

export function computeContactQualityGameHr(
  linearScore: number,
  expectedPA: number,
): {
  probability: number
  probRaw: number
  tier: ReturnType<typeof assignTier>
  pPa: number
  x: number
  lambda: number
  dataQuality: 'full' | 'partial' | 'low'
} {
  const x = linearScore
  const pPa = perPaProbability(x)
  const { lambda, probability: pGame } = poissonGameHrProbability(pPa, expectedPA)
  const prob = applyCapAndFloor(pGame)
  const tier = assignTier(prob)
  const dataQuality: 'full' | 'partial' | 'low' = 'partial'
  return { probability: prob, probRaw: pGame, tier, pPa, x, lambda, dataQuality }
}
