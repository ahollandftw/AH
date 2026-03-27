import type { HrModelCoefficients } from './constants.js'
import {
  DEFAULT_HR_COEFFICIENTS,
  HR_PROB_MAX,
  HR_PROB_MIN,
} from './constants.js'

export type HrFeatureZ = {
  zHrPerPa: number | null
  zPower: number | null
  zPitcher: number | null
  zMatchup: number | null
  zPark: number | null
  zHandedness: number | null
  zWeather: number | null
}

const TERM_ORDER: { feature: keyof HrFeatureZ; coeff: keyof HrModelCoefficients }[] = [
  { feature: 'zHrPerPa', coeff: 'b1' },
  { feature: 'zPower', coeff: 'b2' },
  { feature: 'zPitcher', coeff: 'b3' },
  { feature: 'zMatchup', coeff: 'b4' },
  { feature: 'zPark', coeff: 'b5' },
  { feature: 'zHandedness', coeff: 'b6' },
  { feature: 'zWeather', coeff: 'b7' },
]

/**
 * Redistribute coefficient mass from dropped (null) features onto remaining terms proportionally.
 */
function effectiveCoeffs(
  coeffs: HrModelCoefficients,
  features: HrFeatureZ,
): { b0: number; terms: { b: number; z: number }[] } {
  const base = { ...coeffs }
  const rows: { b: number; z: number }[] = []
  let sumActive = 0
  for (const { feature, coeff } of TERM_ORDER) {
    const z = features[feature]
    const b = base[coeff]
    if (z != null && Number.isFinite(z)) {
      rows.push({ b, z })
      sumActive += b
    }
  }
  if (rows.length === 0) {
    return { b0: base.b0, terms: [] }
  }
  const targetSum = TERM_ORDER.reduce((s, t) => s + base[t.coeff], 0)
  const scale = targetSum > 0 && sumActive > 0 ? targetSum / sumActive : 1
  return {
    b0: base.b0,
    terms: rows.map((r) => ({ b: r.b * scale, z: r.z })),
  }
}

/** Per-PA logit → game HR probability with expected PA; clamp at end only. */
export function computeGameHrProbability(args: {
  features: HrFeatureZ
  coeffs?: HrModelCoefficients
  expectedPa: number
  playerLabel?: string
}): { probability: number; tier: string; pPa: number; x: number } {
  const coeffs = args.coeffs ?? DEFAULT_HR_COEFFICIENTS
  const { b0, terms } = effectiveCoeffs(coeffs, args.features)
  let x = b0
  for (const t of terms) {
    x += t.b * t.z
  }

  const pPa = 1 / (1 + Math.exp(-x))
  const pa = Math.max(0.1, args.expectedPa)
  let p = 1 - Math.pow(1 - pPa, pa)
  p = Math.max(HR_PROB_MIN, Math.min(HR_PROB_MAX, p))

  const tier = probToTier(p)
  return { probability: p, tier, pPa, x }
}

export function probToTier(prob: number): string {
  const pct = prob * 100
  if (pct >= 25) return 'A+'
  if (pct >= 20) return 'A'
  if (pct >= 15) return 'B'
  if (pct >= 10) return 'C'
  return 'D'
}
