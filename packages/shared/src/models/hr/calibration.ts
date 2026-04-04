/**
 * Calibration constants for the HR probability engine.
 * Logistic intercept matches league-average per-PA HR rate at neutral z-scores.
 */
const LEAGUE_HR_PER_PA = 0.036

export const CALIBRATION = {
  leagueAvgHrPerPa: LEAGUE_HR_PER_PA,
  /** Log-odds at p = league HR/PA — used when all z-features are 0. */
  intercept: Math.log(LEAGUE_HR_PER_PA / (1 - LEAGUE_HR_PER_PA)),

  shrinkageAlpha: 200,

  coefficients: {
    matchup: 0.65,
    power: 0.35,
    fb: 0.25,
    contact: 0.2,
    park: 0.2,
    handedness: 0.15,
    weather: 0.1,
    lineupSpot: 0.1,
    recentForm: 0.1,
    pull: 0.08,
  },

  /** Post-hoc cap on P(at least one HR this game). */
  cap: 0.35 as number | null,
  floor: 0.01,

  leagueAvgGameHrProb: 0.115,
  expectedPaDefault: 4.2,

  /** Clamp logistic per-PA probability before Poisson step. */
  perPaProbMin: 0.005,
  perPaProbMax: 0.12,
} as const

export type CalibrationCoeffKey = keyof typeof CALIBRATION.coefficients

/** Fixed league distribution constants — recalibrate annually. */
export const LEAGUE = {
  hrPerPa: { mean: 0.036, std: 0.022 },
  /** Fallback when empirical log-matchup distribution unavailable (single-player / tiny slate). */
  logMatchupHrRate: { mean: Math.log(LEAGUE_HR_PER_PA), std: 0.5 },
  iso: { mean: 0.155, std: 0.045 },
  barrelRate: { mean: 0.082, std: 0.04 },
  /** Hard-hit rate (balls in play), decimal. */
  hardHitRate: { mean: 0.39, std: 0.085 },
  /** Fly-ball share of batted balls, decimal. */
  flyBallRate: { mean: 0.235, std: 0.055 },
  /** Strikeout rate (PA), decimal. */
  strikeoutRate: { mean: 0.22, std: 0.06 },
  /** Pull share of batted balls, decimal. */
  pullRate: { mean: 0.395, std: 0.065 },
  /** Statcast avg exit velocity (mph), batting or pitching-against. */
  avgExitVelo: { mean: 88.5, std: 3.5 },
  /** Sweet-spot share of batted balls, decimal (Statcast anglesweetspotpercent). */
  sweetSpotRate: { mean: 0.33, std: 0.075 },
  hrPer9: { mean: 1.35, std: 0.38 },
  park: { mean: 100, std: 12 },
  recentHrRate: { mean: 0.036, std: 0.055 },
  arsenal: { mean: 0, std: 3.2 },
  weather: { mean: 0, std: 0.8 },
} as const
