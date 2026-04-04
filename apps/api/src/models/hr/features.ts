import { CALIBRATION, LEAGUE, type CalibrationCoeffKey } from './calibration.js'
import { zScore } from './normalize.js'

export type Hand = 'L' | 'R' | 'S'

export interface BatterFeatureInput {
  hrPerPa: number | null
  hand: Hand
  lineupPosition: number | null
  hrPerPaVsL?: number | null
  hrPerPaVsR?: number | null
  hrLast7?: number | null
  paLast7?: number | null
  hrLast14?: number | null
  paLast14?: number | null
}

export interface WeatherInput {
  tempF: number
  windSpeedMph: number
  windDirectionDeg: number
  humidityPct: number
}

/** Empirical Bayes shrinkage toward league HR/PA. */
export function shrinkRate(
  hr: number,
  pa: number,
  leagueRate: number,
  alpha = CALIBRATION.shrinkageAlpha,
): number {
  return (hr + alpha * leagueRate) / (pa + alpha)
}

/**
 * Log-space blend of batter vs pitcher HR skill vs league baseline.
 * Expects already-shrunk per-PA rates.
 */
export function computeMatchupHrRate(
  batterShrunkRate: number,
  pitcherShrunkRate: number,
  leagueRate: number = CALIBRATION.leagueAvgHrPerPa,
): number {
  const b = Math.max(batterShrunkRate, 1e-6)
  const p = Math.max(pitcherShrunkRate, 1e-6)
  const L = leagueRate
  const logMatchup = 0.6 * Math.log(b) + 0.4 * Math.log(p) - Math.log(L)
  return Math.exp(logMatchup)
}

/**
 * z-score of log(matchup HR rate). Pass `logDistribution` from the current slate
 * (mean/std of log matchup across projected players) when available.
 */
export function zMatchup(
  matchupHrRate: number | null,
  logDistribution?: { mean: number; std: number } | null,
): number | null {
  if (matchupHrRate == null || !Number.isFinite(matchupHrRate) || matchupHrRate <= 0) return null
  const logM = Math.log(matchupHrRate)
  const mean = logDistribution?.mean ?? LEAGUE.logMatchupHrRate.mean
  const std = Math.max(logDistribution?.std ?? LEAGUE.logMatchupHrRate.std, 0.12)
  return zScore(logM, mean, std)
}

function zRecentFormWindow(hr: number | null, pa: number | null, window: 7 | 14): number | null {
  if (hr == null || pa == null) return null
  const minPa = window === 7 ? 12 : 24
  if (pa < minPa) return null
  const recentRate = hr / pa
  return zScore(recentRate, LEAGUE.recentHrRate.mean, LEAGUE.recentHrRate.std)
}

export function zRecentForm(
  hrLast7: number | null,
  paLast7: number | null,
  hrLast14: number | null,
  paLast14: number | null,
): number | null {
  const z7 = zRecentFormWindow(hrLast7, paLast7, 7)
  const z14 = zRecentFormWindow(hrLast14, paLast14, 14)
  if (z7 == null && z14 == null) return null
  if (z7 != null && z14 != null) return z7 * 0.65 + z14 * 0.35
  return z7 ?? z14
}

export function zPark(parkFactor: number | null): number | null {
  return zScore(parkFactor, LEAGUE.park.mean, LEAGUE.park.std)
}

export function zHandedness(batter: BatterFeatureInput, pitcherHand: Hand | null): number | null {
  if (!pitcherHand) return null

  if (pitcherHand === 'L' && batter.hrPerPaVsL != null) {
    return zScore(batter.hrPerPaVsL, LEAGUE.hrPerPa.mean, LEAGUE.hrPerPa.std)
  }
  if (pitcherHand === 'R' && batter.hrPerPaVsR != null) {
    return zScore(batter.hrPerPaVsR, LEAGUE.hrPerPa.mean, LEAGUE.hrPerPa.std)
  }

  const effectiveHand: Hand =
    batter.hand === 'S' ? (pitcherHand === 'L' ? 'R' : 'L') : batter.hand

  const platoonAdj: Record<string, number> = {
    R_L: 0.8,
    L_R: 0.5,
    R_R: -0.35,
    L_L: -0.45,
  }
  return platoonAdj[`${effectiveHand}_${pitcherHand}`] ?? 0
}

export function zLineupSpot(lineupPosition: number | null): number {
  if (lineupPosition == null) return 0
  const spotAdj: Record<number, number> = {
    1: 0.3, 2: 0.5, 3: 0.6, 4: 0.7, 5: 0.3,
    6: 0, 7: -0.2, 8: -0.4, 9: -0.6,
  }
  return spotAdj[lineupPosition] ?? 0
}

export function expectedPaForSpot(lineupPosition: number | null): number {
  if (lineupPosition == null) return CALIBRATION.expectedPaDefault
  const paMap: Record<number, number> = {
    1: 4.6, 2: 4.5, 3: 4.4, 4: 4.3,
    5: 4.2, 6: 4.1, 7: 4.0, 8: 3.8, 9: 3.5,
  }
  return paMap[lineupPosition] ?? CALIBRATION.expectedPaDefault
}

export function zWeather(weather: WeatherInput | null): number | null {
  if (!weather) return null
  const tempScore = (weather.tempF - 72) / 15
  const windDirectionFactor = -Math.cos((weather.windDirectionDeg * Math.PI) / 180)
  const windScore = (weather.windSpeedMph * windDirectionFactor) / 12
  const humidScore = (weather.humidityPct - 50) / 150
  const composite = tempScore * 0.45 + windScore * 0.45 + humidScore * 0.1
  return zScore(composite, LEAGUE.weather.mean, LEAGUE.weather.std)
}

/** Barrel + hard-hit, decimal rates (0–1). Hard-hit optional → barrel-only. */
export function zPower(barrelDec: number | null, hardHitDec: number | null): number {
  const zb =
    barrelDec != null ? zScore(barrelDec, LEAGUE.barrelRate.mean, LEAGUE.barrelRate.std) : null
  const zh =
    hardHitDec != null ? zScore(hardHitDec, LEAGUE.hardHitRate.mean, LEAGUE.hardHitRate.std) : null
  if (zh == null) return zb ?? 0
  if (zb == null) return zh ?? 0
  return zb * 0.7 + zh * 0.3
}

export function zFlyBall(flyBallDec: number | null): number {
  if (flyBallDec == null) return 0
  return zScore(flyBallDec, LEAGUE.flyBallRate.mean, LEAGUE.flyBallRate.std) ?? 0
}

/** Higher K% → worse contact for HR → negative z. */
export function zContact(strikeoutDec: number | null): number {
  if (strikeoutDec == null) return 0
  const z = zScore(strikeoutDec, LEAGUE.strikeoutRate.mean, LEAGUE.strikeoutRate.std)
  return z == null ? 0 : -z
}

export function zPull(pullDec: number | null): number {
  if (pullDec == null) return 0
  return zScore(pullDec, LEAGUE.pullRate.mean, LEAGUE.pullRate.std) ?? 0
}

/**
 * Redistribute coefficient mass from missing features onto present ones.
 * (Kept for tooling; linear score uses missing = 0 instead.)
 */
export function adjustedCoefficients(
  presentFeatures: CalibrationCoeffKey[],
): Partial<Record<CalibrationCoeffKey, number>> {
  const all = Object.keys(CALIBRATION.coefficients) as CalibrationCoeffKey[]
  const totalMass = all.reduce((s, k) => s + CALIBRATION.coefficients[k], 0)
  const missingMass = all
    .filter((k) => !presentFeatures.includes(k))
    .reduce((s, k) => s + CALIBRATION.coefficients[k], 0)
  const presentMass = totalMass - missingMass
  const scale = presentMass > 0 ? 1 + missingMass / presentMass : 1

  const result: Partial<Record<CalibrationCoeffKey, number>> = {}
  for (const k of presentFeatures) {
    result[k] = CALIBRATION.coefficients[k] * scale
  }
  return result
}
