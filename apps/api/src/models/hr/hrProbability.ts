import { CALIBRATION, type CalibrationCoeffKey } from './calibration.js'
import { adjustedCoefficients } from './features.js'

export type Tier = 'A+' | 'A' | 'B' | 'C' | 'D'

export interface NormalizedFeatures {
  zHrPerPa:      number | null
  zPower:        number | null
  zArsenal:      number | null
  zPark:         number | null
  zHandedness:   number | null
  zWeather:      number | null
  zRecentForm7:  number | null
  zRecentForm14: number | null
  zLineupSpot:   number | null
  expectedPA:    number
  arsenalRaw?:   number | null
  arsenalDetail?: unknown[]
  featuresPresent: CalibrationCoeffKey[]
}

const FEATURE_TO_COEFF: { feature: keyof NormalizedFeatures; coeff: CalibrationCoeffKey }[] = [
  { feature: 'zHrPerPa',      coeff: 'hrPerPa'      },
  { feature: 'zPower',        coeff: 'power'        },
  { feature: 'zArsenal',      coeff: 'arsenal'      },
  { feature: 'zPark',         coeff: 'park'         },
  { feature: 'zHandedness',   coeff: 'handedness'   },
  { feature: 'zWeather',      coeff: 'weather'      },
  { feature: 'zRecentForm7',  coeff: 'recentForm7'  },
  { feature: 'zRecentForm14', coeff: 'recentForm14' },
  { feature: 'zLineupSpot',   coeff: 'lineupSpot'   },
]

export function computeLinearScore(features: NormalizedFeatures): number {
  const present: CalibrationCoeffKey[] = []
  for (const { feature, coeff } of FEATURE_TO_COEFF) {
    const z = features[feature]
    if (z != null && Number.isFinite(z as number)) {
      present.push(coeff)
    }
  }

  if (present.length === 0) return CALIBRATION.intercept

  const adj = adjustedCoefficients(present)
  let x = CALIBRATION.intercept
  for (const { feature, coeff } of FEATURE_TO_COEFF) {
    const z = features[feature] as number | null
    const b = adj[coeff]
    if (z != null && b != null && Number.isFinite(z)) {
      x += b * z
    }
  }
  return x
}

export function perPaProbability(linearScore: number): number {
  return 1 / (1 + Math.exp(-linearScore))
}

export function gameHrProbability(perPaProb: number, expectedPA: number): number {
  return 1 - Math.pow(1 - perPaProb, expectedPA)
}

export function applyCapAndFloor(rawProb: number): number {
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
  features:    NormalizedFeatures
  dataQuality: 'full' | 'partial' | 'low'
}

/**
 * Full single-player projection pipeline.
 * Takes pre-computed normalized features, runs the linear score → sigmoid → binomial → cap/floor.
 */
export function computeGameHrProbability(features: NormalizedFeatures): ProjectionResult {
  const x     = computeLinearScore(features)
  const pPa   = perPaProbability(x)
  const pGame = gameHrProbability(pPa, features.expectedPA)
  const prob  = applyCapAndFloor(pGame)
  const tier  = assignTier(prob)

  const hasArsenal = features.zArsenal != null
  const presentCount = features.featuresPresent.length
  const dataQuality: 'full' | 'partial' | 'low' =
    hasArsenal && presentCount >= 7 ? 'full'
    : presentCount >= 4 ? 'partial'
    : 'low'

  return { probability: prob, probRaw: pGame, tier, pPa, x, features, dataQuality }
}
