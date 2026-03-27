/** Tunable logistic HR model coefficients (per-PA linear score → sigmoid). */

export type HrModelCoefficients = {
  b0: number
  b1: number
  b2: number
  b3: number
  b4: number
  b5: number
  b6: number
  b7: number
}

export const DEFAULT_HR_COEFFICIENTS: HrModelCoefficients = {
  b0: -3.2,
  b1: 0.8,
  b2: 1.1,
  b3: 0.7,
  b4: 0.6,
  b5: 0.5,
  b6: 0.4,
  b7: 0.3,
}

export const HR_PROB_MIN = 0.01
export const HR_PROB_MAX = 0.6

/** Power sub-feature weights (must sum to 1). */
export const POWER_WEIGHTS = {
  barrel: 0.3,
  ev95: 0.25,
  avgHit: 0.15,
  flyBall: 0.15,
  hrPerFb: 0.15,
} as const

/** Pitcher composite weights (spec; barrel/fb/gb are z-scored). */
export const PITCHER_WEIGHTS = {
  hrProxy: 0.4,
  barrelAllowed: 0.3,
  flyBallAllowed: 0.2,
  groundBall: -0.1,
} as const
