import { CALIBRATION, LEAGUE, type CalibrationCoeffKey } from './calibration.js'
import { zScore } from './normalize.js'

export type Hand = 'L' | 'R' | 'S'

export interface BatterFeatureInput {
  hrPerPa:       number | null
  barrelRate:    number | null
  iso:           number | null
  hand:          Hand
  lineupPosition: number | null
  hrPerPaVsL?:   number | null
  hrPerPaVsR?:   number | null
  hrLast7?:      number | null
  paLast7?:      number | null
  hrLast14?:     number | null
  paLast14?:     number | null
}

export interface WeatherInput {
  tempF:            number
  windSpeedMph:     number
  windDirectionDeg: number
  humidityPct:      number
}

export function zHrPerPa(hrPerPa: number | null): number | null {
  return zScore(hrPerPa, LEAGUE.hrPerPa.mean, LEAGUE.hrPerPa.std)
}

export function zPower(batter: BatterFeatureInput): number | null {
  if (batter.barrelRate != null && batter.barrelRate > 0) {
    return zScore(batter.barrelRate, LEAGUE.barrelRate.mean, LEAGUE.barrelRate.std)
  }
  return zScore(batter.iso, LEAGUE.iso.mean, LEAGUE.iso.std)
}

export function zRecentForm(hr: number | null, pa: number | null, window: 7 | 14): number {
  if (hr == null || pa == null) return 0
  const minPa = window === 7 ? 12 : 24
  if (pa < minPa) return 0
  const recentRate = hr / pa
  return zScore(recentRate, LEAGUE.recentHrRate.mean, LEAGUE.recentHrRate.std) ?? 0
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
    batter.hand === 'S'
      ? (pitcherHand === 'L' ? 'R' : 'L')
      : batter.hand

  const platoonAdj: Record<string, number> = {
    'R_L':  0.80,
    'L_R':  0.50,
    'R_R': -0.35,
    'L_L': -0.45,
  }
  return platoonAdj[`${effectiveHand}_${pitcherHand}`] ?? 0
}

export function zLineupSpot(lineupPosition: number | null): number {
  if (lineupPosition == null) return 0
  const spotAdj: Record<number, number> = {
    1: 0.30, 2: 0.50, 3: 0.60, 4: 0.70, 5: 0.30,
    6: 0.00, 7: -0.20, 8: -0.40, 9: -0.60,
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
  const composite = (tempScore * 0.45) + (windScore * 0.45) + (humidScore * 0.10)
  return zScore(composite, LEAGUE.weather.mean, LEAGUE.weather.std)
}

/**
 * Redistribute coefficient mass from missing features onto present ones.
 * When a feature is unavailable its weight is spread proportionally — NOT dropped.
 */
export function adjustedCoefficients(
  presentFeatures: CalibrationCoeffKey[],
): Partial<Record<CalibrationCoeffKey, number>> {
  const all = Object.keys(CALIBRATION.coefficients) as CalibrationCoeffKey[]
  const totalMass   = all.reduce((s, k) => s + CALIBRATION.coefficients[k], 0)
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
