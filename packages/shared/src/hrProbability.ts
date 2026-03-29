/**
 * HR helpers + legacy input shape bridged to the new calibrated logistic model.
 */
import {
  computeGameHrProbability,
  type NormalizedFeatures,
} from './models/hr/hrProbability.js'
import { expectedPaFromLineupSlot } from './models/hr/expectedPA.js'
import { computeMatchupHrRate, zMatchup } from './models/hr/features.js'

export type HrProbabilityInput = {
  brl_percent: number
  ev95percent: number
  avg_hit_speed: number
  fbld: number
  hr_total: number
  attempts: number
  pitcher_hr_total: number
  matchup_score: number
}

export type HrProbabilityResult = {
  probability: number
  probabilityPct: string
  americanOdds: number
  americanOddsStr: string
  tier: string
  powerScore: number
  pitcherFactor: number
  normalizedMatchup: number
  baseHrRate: number
}

const LEAGUE_AVG_HR_TOTAL = 20
const LEAGUE_AVG_MATCHUP = 0.400

export function calcPowerScore(
  brl_percent: number,
  ev95percent: number,
  avg_hit_speed: number,
  fbld: number,
): number {
  return (
    0.35 * brl_percent +
    0.25 * ev95percent +
    0.20 * (avg_hit_speed / 100) +
    0.20 * fbld
  )
}

export function calcPitcherFactor(
  pitcher_hr_total: number,
  league_avg_hr_total = LEAGUE_AVG_HR_TOTAL,
): number {
  if (league_avg_hr_total <= 0) return 1
  return pitcher_hr_total / league_avg_hr_total
}

export function calcNormalizedMatchup(
  matchup_score: number,
  league_avg_matchup = LEAGUE_AVG_MATCHUP,
): number {
  if (league_avg_matchup <= 0) return 1
  return matchup_score / league_avg_matchup
}

export function calcBaseHrRate(hr_total: number, attempts: number): number {
  if (attempts <= 0) return 0
  return hr_total / attempts
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

export function probToTier(prob: number): string {
  const pct = prob * 100
  if (pct >= 25) return 'A+'
  if (pct >= 20) return 'A'
  if (pct >= 15) return 'B'
  if (pct >= 10) return 'C'
  return 'D'
}

/**
 * Bridges legacy scalar inputs to the new calibrated logistic model.
 * Uses coarse z-scores — prefer using the daily engine output instead.
 */
export function calculateHrProbability(input: HrProbabilityInput): HrProbabilityResult {
  const baseHrRate = calcBaseHrRate(input.hr_total, input.attempts)
  const powerScore = calcPowerScore(
    input.brl_percent,
    input.ev95percent,
    input.avg_hit_speed,
    input.fbld,
  )
  const pitcherFactor = calcPitcherFactor(input.pitcher_hr_total)
  const normalizedMatchup = calcNormalizedMatchup(input.matchup_score)

  const pitcherHrPerPaAllowed =
    input.attempts > 0 && input.pitcher_hr_total > 0
      ? input.pitcher_hr_total / Math.max(input.attempts * 4, 1)
      : 0.036
  const matchupHrRate = computeMatchupHrRate(baseHrRate, pitcherHrPerPaAllowed)
  const matchupZ = zMatchup(matchupHrRate)

  const features: NormalizedFeatures = {
    zMatchup:      matchupZ,
    zPark:         null,
    zHandedness:   null,
    zWeather:      null,
    zRecentForm:   null,
    zLineupSpot:   0,
    expectedPA:    expectedPaFromLineupSlot(undefined),
    matchupHrRate,
    featuresPresent: matchupZ != null ? ['matchup'] : [],
  }

  const out = computeGameHrProbability(features)
  const probability = out.probability
  const americanOdds = probToAmericanOdds(probability)

  return {
    probability,
    probabilityPct: `${Math.round(probability * 1000) / 10}%`,
    americanOdds,
    americanOddsStr: formatAmericanOdds(americanOdds),
    tier: out.tier,
    powerScore,
    pitcherFactor,
    normalizedMatchup,
    baseHrRate,
  }
}
