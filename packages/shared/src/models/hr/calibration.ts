/**
 * Calibration constants for the HR probability engine.
 *
 * Current model uses a single matchup-driven HR rate as the primary signal.
 * Secondary terms are intentionally small so they only make marginal adjustments.
 */
export const CALIBRATION = {
  intercept: -4.8,

  coefficients: {
    matchup:      0.90,
    park:         0.20,
    handedness:   0.15,
    weather:      0.10,
    lineupSpot:   0.10,
    recentForm:   0.10,
  },

  cap:   null,
  floor: 0.01,

  leagueAvgHrPerPa:    0.036,
  leagueAvgGameHrProb: 0.115,
  expectedPaDefault:   4.2,
} as const

export type CalibrationCoeffKey = keyof typeof CALIBRATION.coefficients

/** Fixed league distribution constants — recalibrate annually. */
export const LEAGUE = {
  hrPerPa:      { mean: 0.036,  std: 0.022  },
  logMatchupHrRate: { mean: Math.log(0.036), std: 0.5 },
  iso:          { mean: 0.155,  std: 0.045  },
  barrelRate:   { mean: 0.082,  std: 0.040  },
  hrPer9:       { mean: 1.35,   std: 0.38   },
  park:         { mean: 100,    std: 12     },
  recentHrRate: { mean: 0.036,  std: 0.055  },
  arsenal:      { mean: 0,      std: 3.2    },
  weather:      { mean: 0,      std: 0.80   },
} as const
