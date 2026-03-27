/**
 * Calibration constants for the HR probability engine.
 *
 * b0 = -4.8 is load-bearing. With all z-scores at 0 (average batter vs average
 * pitcher), sigmoid(-4.8) ≈ 0.82% per PA → ~13.2% game probability at 4.2 PA.
 * Do NOT raise b0 above -4.5 without full historical recalibration.
 */
export const CALIBRATION = {
  intercept: -4.8,

  coefficients: {
    hrPerPa:      0.55,
    power:        0.75,
    arsenal:      0.90,
    park:         0.35,
    handedness:   0.28,
    weather:      0.20,
    recentForm7:  0.40,
    recentForm14: 0.25,
    lineupSpot:   0.15,
  },

  cap:   0.33,
  floor: 0.01,

  leagueAvgHrPerPa:    0.036,
  leagueAvgGameHrProb: 0.115,
  expectedPaDefault:   4.2,
} as const

export type CalibrationCoeffKey = keyof typeof CALIBRATION.coefficients

/** Fixed league distribution constants — recalibrate annually. */
export const LEAGUE = {
  hrPerPa:      { mean: 0.036,  std: 0.022  },
  iso:          { mean: 0.155,  std: 0.045  },
  barrelRate:   { mean: 0.082,  std: 0.040  },
  hrPer9:       { mean: 1.35,   std: 0.38   },
  park:         { mean: 100,    std: 12     },
  recentHrRate: { mean: 0.036,  std: 0.055  },
  arsenal:      { mean: 0,      std: 3.2    },
  weather:      { mean: 0,      std: 0.80   },
} as const
