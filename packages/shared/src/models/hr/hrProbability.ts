import { CALIBRATION, type CalibrationCoeffKey } from './calibration.js'

export type Tier = 'A+' | 'A' | 'B' | 'C' | 'D'

export interface NormalizedFeatures {
  zMatchup:      number | null
  zPark:         number | null
  zHandedness:   number | null
  zWeather:      number | null
  zRecentForm:   number | null
  zLineupSpot:   number | null
  expectedPA:    number
  matchupHrRate?: number | null
  featuresPresent: CalibrationCoeffKey[]
}

const FEATURE_TO_COEFF: { feature: keyof NormalizedFeatures; coeff: CalibrationCoeffKey }[] = [
  { feature: 'zMatchup',      coeff: 'matchup'      },
  { feature: 'zPark',         coeff: 'park'         },
  { feature: 'zHandedness',   coeff: 'handedness'   },
  { feature: 'zWeather',      coeff: 'weather'      },
  { feature: 'zRecentForm',   coeff: 'recentForm'   },
  { feature: 'zLineupSpot',   coeff: 'lineupSpot'   },
]

export function computeLinearScore(features: NormalizedFeatures): number {
  let x = CALIBRATION.intercept
  for (const { feature, coeff } of FEATURE_TO_COEFF) {
    const z = features[feature] as number | null
    const b = CALIBRATION.coefficients[coeff]
    if (z != null && Number.isFinite(z)) {
      x += b * z
    }
  }
  return x
}

export function perPaProbability(linearScore: number): number {
  return 1 / (1 + Math.exp(-linearScore))
}

export function poissonGameHrProbability(perPaProb: number, expectedPA: number): { lambda: number; probability: number } {
  const lambda = perPaProb * expectedPA
  return {
    lambda,
    probability: 1 - Math.exp(-lambda),
  }
}

export function applyCapAndFloor(rawProb: number): number {
  if (CALIBRATION.cap == null) return Math.max(CALIBRATION.floor, rawProb)
  return Math.max(CALIBRATION.floor, Math.min(CALIBRATION.cap, rawProb))
}

export function assignTier(prob: number): Tier {
  if (prob >= 0.25) return 'A+'
  if (prob >= 0.20) return 'A'
  if (prob >= 0.15) return 'B'
  if (prob >= 0.10) return 'C'
  return 'D'
}

export function probToTier(prob: number): string {
  return assignTier(prob)
}

export function probToAmericanOdds(prob: number): number {
  if (prob <= 0) return 9999
  if (prob >= 1) return -9999
  if (prob >= 0.5) return Math.round(-(prob / (1 - prob)) * 100)
  return Math.round(((1 - prob) / prob) * 100)
}

export function formatAmericanOdds(odds: number): string {
  return odds >= 0 ? `+${odds}` : `${odds}`
}

export interface ProjectionResult {
  probability: number
  probRaw:     number
  tier:        Tier
  pPa:         number
  x:           number
  lambda:      number
  features:    NormalizedFeatures
  dataQuality: 'full' | 'partial' | 'low'
}

type DistributionMetric = {
  min: number
  p50: number
  avg: number
  p90: number
  max: number
}

function summarizeMetric(values: number[]): DistributionMetric | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!xs.length) return null
  const pick = (p: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.floor((xs.length - 1) * p)))]!
  const avg = xs.reduce((sum, value) => sum + value, 0) / xs.length
  return {
    min: xs[0]!,
    p50: pick(0.5),
    avg,
    p90: pick(0.9),
    max: xs[xs.length - 1]!,
  }
}

export function summarizeProjectionDistribution(
  rows: Array<{ matchupHrRate: number | null; zMatchup: number | null; x: number; pPa: number; lambda: number; probRaw: number }>,
) {
  return {
    count: rows.length,
    matchupHrRate: summarizeMetric(rows.map((row) => row.matchupHrRate ?? Number.NaN)),
    zMatchup: summarizeMetric(rows.map((row) => row.zMatchup ?? Number.NaN)),
    x: summarizeMetric(rows.map((row) => row.x)),
    pPa: summarizeMetric(rows.map((row) => row.pPa)),
    lambda: summarizeMetric(rows.map((row) => row.lambda)),
    pRaw: summarizeMetric(rows.map((row) => row.probRaw)),
  }
}

/**
 * Full single-player projection pipeline.
 * Takes pre-computed normalized features, runs the linear score → sigmoid → Poisson → floor/cap.
 */
export function computeGameHrProbability(features: NormalizedFeatures): ProjectionResult {
  const x = computeLinearScore(features)
  const pPa = perPaProbability(x)
  const { lambda, probability: pGame } = poissonGameHrProbability(pPa, features.expectedPA)
  const prob  = applyCapAndFloor(pGame)
  const tier  = assignTier(prob)

  const hasMatchup = features.zMatchup != null
  const presentCount = features.featuresPresent.length
  const dataQuality: 'full' | 'partial' | 'low' =
    hasMatchup && presentCount >= 4 ? 'full'
    : hasMatchup ? 'partial'
    : 'low'

  return { probability: prob, probRaw: pGame, tier, pPa, x, lambda, features, dataQuality }
}
