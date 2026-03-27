import { zScore } from './normalize.js'
import { PITCHER_WEIGHTS, POWER_WEIGHTS } from './constants.js'

export type RawBatterPowerParts = {
  barrelRate: number | null
  ev95: number | null
  avgHitSpeed: number | null
  flyBallRate: number | null
  hrPerFb: number | null
}

/** Combine raw power parts using league z-scores (missing z → drop that term, renormalize weights). */
export function combinePowerZ(
  raw: RawBatterPowerParts,
  league: {
    barrel: { mean: number; std: number }
    ev95: { mean: number; std: number }
    avgHit: { mean: number; std: number }
    flyBall: { mean: number; std: number }
    hrPerFb: { mean: number; std: number }
  },
): number | null {
  const zb = zScore(raw.barrelRate, league.barrel.mean, league.barrel.std)
  const z9 = zScore(raw.ev95, league.ev95.mean, league.ev95.std)
  const za = zScore(raw.avgHitSpeed, league.avgHit.mean, league.avgHit.std)
  const zf = zScore(raw.flyBallRate, league.flyBall.mean, league.flyBall.std)
  const zh = zScore(raw.hrPerFb, league.hrPerFb.mean, league.hrPerFb.std)

  const parts: { w: number; z: number | null }[] = [
    { w: POWER_WEIGHTS.barrel, z: zb },
    { w: POWER_WEIGHTS.ev95, z: z9 },
    { w: POWER_WEIGHTS.avgHit, z: za },
    { w: POWER_WEIGHTS.flyBall, z: zf },
    { w: POWER_WEIGHTS.hrPerFb, z: zh },
  ]
  const active = parts.filter((p) => p.z != null) as { w: number; z: number }[]
  if (active.length === 0) return null
  const wSum = active.reduce((s, p) => s + p.w, 0)
  if (wSum < 1e-9) return null
  return active.reduce((s, p) => s + p.w * p.z, 0) / wSum
}

export type RawPitcherParts = {
  hrProxy: number | null
  barrelAllowed: number | null
  flyBallAllowed: number | null
  groundBallRate: number | null
}

export function combinePitcherZ(
  raw: RawPitcherParts,
  league: {
    hrProxy: { mean: number; std: number }
    barrel: { mean: number; std: number }
    flyBall: { mean: number; std: number }
    groundBall: { mean: number; std: number }
  },
): number | null {
  const zh = zScore(raw.hrProxy, league.hrProxy.mean, league.hrProxy.std)
  const zb = zScore(raw.barrelAllowed, league.barrel.mean, league.barrel.std)
  const zf = zScore(raw.flyBallAllowed, league.flyBall.mean, league.flyBall.std)
  const zg = zScore(raw.groundBallRate, league.groundBall.mean, league.groundBall.std)

  const terms: { w: number; z: number | null }[] = [
    { w: PITCHER_WEIGHTS.hrProxy, z: zh },
    { w: PITCHER_WEIGHTS.barrelAllowed, z: zb },
    { w: PITCHER_WEIGHTS.flyBallAllowed, z: zf },
    { w: PITCHER_WEIGHTS.groundBall, z: zg },
  ]
  const active = terms.filter((t) => t.z != null) as { w: number; z: number }[]
  if (active.length === 0) return null
  const absSum = active.reduce((s, t) => s + Math.abs(t.w), 0)
  if (absSum < 1e-9) return null
  return active.reduce((s, t) => s + t.w * t.z, 0) / absSum
}
