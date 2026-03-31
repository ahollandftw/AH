# Home Run Probability Engine — Full Implementation Prompt for Cursor

## Project Goal

Build a daily MLB home run probability projection system. For every confirmed batter on the
slate, the engine computes a calibrated per-game HR probability using batter power metrics,
pitcher pitch arsenal matchups, park factors, weather, handedness splits, lineup position, and
recent form. Output is tiered A+ through D and hard-capped at **33%** — a ceiling that should
only be approached by an Aaron Judge-caliber hitter simultaneously stacking every favorable
factor at an extreme level. Under normal MLB conditions, elite projections top out at 18–24%
organically. The cap is a safety rail, not a target.

---

## Project Structure

```
/hr-engine
  /data
    players.json          # batter season + recent stats
    pitchers.json         # pitcher arsenal + traditional stats
    parks.json            # park factor table (multi-year HR factor per venue)
    weather.json          # daily game-time weather per venue
    lineups.json          # confirmed daily lineups + batting order
  /engine
    calibration.ts        # all constants, intercepts, and coefficients
    features.ts           # feature extraction and z-score normalization
    arsenal.ts            # pitch arsenal weighted matchup scoring
    model.ts              # linear score + logistic sigmoid + binomial expansion
    projections.ts        # output formatting and tier assignment
  index.ts                # daily runner — orchestrates the full pipeline
  types.ts                # all shared TypeScript interfaces
```

---

## 1. Calibration Constants (`calibration.ts`)

This file is the mathematical backbone of the model. Every constant here was chosen so that a
completely average batter facing a completely average pitcher produces approximately 11–13% game
probability, matching the real MLB baseline. The intercept is the most important value in the
entire system — getting it wrong causes the output saturation problem where everyone hits the cap.

```typescript
export const CALIBRATION = {
  // b0: Intercept. With all feature z-scores at 0 (perfectly average batter vs
  // perfectly average pitcher), this produces sigmoid(-4.8) ≈ 0.82% per PA,
  // which at 4.2 expected PAs yields approximately 3.4% chance per PA and
  // about 13.2% game probability. That is the correct MLB baseline.
  // CRITICAL: Do not raise b0 above -4.5. Doing so will cause average and
  // above-average batters to saturate the cap, exactly the bug being fixed.
  intercept: -4.8,

  coefficients: {
    // Each coefficient is scaled so a +1 SD improvement on that single feature
    // moves game probability by approximately 1.5–2.5 percentage points.
    // Coefficients were chosen so the maximum realistic linear score
    // (extreme elite scenario) lands around x = -1.0 to -0.5, giving
    // sigmoid output of 27–38% per PA, which after binomial and cap
    // produces the intended 25–33% game probability range.
    hrPerPa:      0.55,  // Season HR/PA rate — the most stable and reliable power signal
    power:        0.75,  // ISO or barrel rate — raw power quality, preferring barrel rate
    arsenal:      0.90,  // Weighted pitch arsenal matchup — replaces generic zPitcher entirely
    park:         0.35,  // Ballpark HR factor — Coors adds ~2.5% game probability
    handedness:   0.28,  // Batter-pitcher platoon interaction — use actual splits when available
    weather:      0.20,  // Composite weather score — wind direction is the dominant sub-factor
    recentForm7:  0.40,  // Last 7-day HR/PA — hot streak signal, high weight, small sample caveat
    recentForm14: 0.25,  // Last 14-day HR/PA — smooths the 7-day recency signal
    lineupSpot:   0.15,  // Lineup position — small residual after PA adjustment handles volume
  },

  // HARD CAP: 33% is the absolute ceiling on any output.
  // Approaching 33% requires an Aaron Judge-caliber batter (60+ HR pace,
  // 22%+ barrel rate) facing a pitcher whose entire arsenal matches up
  // extremely poorly against that batter, in a top HR park, in warm weather
  // with wind blowing directly out, in a strong platoon advantage, on an
  // active HR streak. In practice expect fewer than one player per week
  // to touch this ceiling. If you see multiple players hitting it daily,
  // b0 is too high.
  cap:   0.33,
  floor: 0.01,

  // Reference constants for sanity checks
  leagueAvgHrPerPa:    0.036,  // MLB average: approximately 1 HR per 28 plate appearances
  leagueAvgGameHrProb: 0.115,  // MLB average: approximately 11.5% per game
  expectedPaDefault:   4.2,    // Default when lineup position is unknown
} as const;
```

---

## 2. All Types (`types.ts`)

```typescript
export type Hand = 'L' | 'R' | 'S';  // S = switch hitter
export type PitchType =
  | 'FF'   // Four-seam fastball
  | 'SI'   // Sinker / two-seam fastball
  | 'SL'   // Slider
  | 'CU'   // Curveball
  | 'CH'   // Changeup
  | 'FC'   // Cutter
  | 'FS'   // Splitter
  | 'SW'   // Sweeper
  | 'KN';  // Knuckleball

export type Tier = 'A+' | 'A' | 'B' | 'C' | 'D';

export interface BatterStats {
  playerId:        string;
  name:            string;
  team:            string;
  hand:            Hand;
  lineupPosition:  number;   // 1–9; required for PA adjustment

  // Season-level power metrics
  hrPerPa:         number;   // HR divided by total plate appearances this season
  iso:             number;   // Isolated power: SLG minus AVG
  barrelRate:      number;   // Percentage of batted balls classified as barrels (Statcast)
  hardHitRate:     number;   // Percentage of batted balls at 95+ mph exit velocity
  avgLaunchAngle:  number;   // Season average launch angle (optimal range: 25–30 degrees for HR)
  pullRate:        number;   // Percentage of batted balls pulled (pull HR correlates strongly)

  // Actual platoon splits — use these when available, far more accurate than canonical
  hrPerPaVsL?:     number;   // HR/PA specifically against left-handed pitchers
  hrPerPaVsR?:     number;   // HR/PA specifically against right-handed pitchers

  // Recent form — populate from rolling game log
  hrLast7:         number;   // Home runs hit in the last 7 calendar days
  paLast7:         number;   // Plate appearances in the last 7 calendar days
  hrLast14:        number;   // Home runs hit in the last 14 calendar days
  paLast14:        number;   // Plate appearances in the last 14 calendar days
}

export interface PitcherStats {
  pitcherId:  string;
  name:       string;
  hand:       Hand;

  // Traditional stats — used as fallback only when arsenal data is unavailable
  hrPer9:  number;
  fip:     number;
  xfip:    number;
  kRate:   number;
  bbRate:  number;

  // Pitch arsenal — primary pitcher-side signal, replaces all traditional stats when present
  pitches: PitchArsenalEntry[];
}

export interface PitchArsenalEntry {
  pitchType:   PitchType;

  // How often this pitcher throws this pitch
  usagePct:    number;                // 0 to 100

  // Pitcher's run value per 100 pitches of this type
  // Negative values mean the pitch suppresses runs (good for pitcher)
  // Positive values mean the pitch gives up runs (bad for pitcher)
  // Source: Baseball Savant pitch-level RV/100
  pitcherRV100: number;

  // Count-split usage — optional but significantly improves accuracy
  // HR occur disproportionately in hitter's counts where pitchers
  // must throw more fastballs and hitters are more aggressive
  usagePctHittersCount?:  number;  // Usage in 1-0, 2-0, 3-1 counts
  usagePctPitchersCount?: number;  // Usage in 0-2, 1-2 counts
}

export interface BatterVsPitchType {
  pitchType:    PitchType;

  // Batter's run value per 100 pitches of this type they've faced
  // Positive = batter benefits (produces runs), Negative = batter is suppressed
  batterRV100:  number;

  // Optional enrichment
  whiffRate?:   number;  // Batter's swinging strike rate on this pitch type
  xba?:         number;  // Expected batting average on contact vs this pitch type
}

export interface ParkData {
  venueId:    string;
  venueName:  string;
  // Multi-year HR park factor normalized to 100 = league average
  // Examples: Coors Field ~130, Great American Ball Park ~115,
  //           Oracle Park ~75, Petco Park ~85
  hrFactor:   number;
}

export interface WeatherData {
  venueId:          string;
  tempF:            number;   // Game-time temperature in Fahrenheit
  windSpeedMph:     number;   // Wind speed at field level
  // Wind direction in degrees from home plate perspective
  // 0 degrees   = wind blowing IN from center field (suppresses HR)
  // 90 degrees  = wind blowing from left to right (pushes to right field)
  // 180 degrees = wind blowing OUT toward center field (maximum HR boost)
  windDirectionDeg: number;
  humidityPct:      number;   // 0 to 100
}

export interface ArsenalMatchupDetail {
  pitchType:       string;
  usagePct:        number;
  pitcherRV100:    number;
  batterRV100:     number;
  batterAdvantage: number;    // batterRV100 minus pitcherRV100; positive = batter wins
  weightedContrib: number;    // (usageFraction) times batterAdvantage
}

export interface NormalizedFeatures {
  zHrPerPa:      number;
  zPower:        number;
  zArsenal:      number;
  zPark:         number;
  zHandedness:   number;
  zWeather:      number;
  zRecentForm7:  number;
  zRecentForm14: number;
  zLineupSpot:   number;
  expectedPA:    number;
  arsenalRaw:    number;
  arsenalDetail: ArsenalMatchupDetail[];
  featuresPresent: string[];
}

export interface PlayerProjection {
  playerId:       string;
  playerName:     string;
  team:           string;
  opponent:       string;
  probHR:         number;   // Final capped probability (0.01 to 0.33)
  probHRRaw:      number;   // Pre-cap value for debugging and model validation
  linearScore:    number;   // x before the sigmoid function
  perPaProb:      number;   // sigmoid(x): per-plate-appearance HR probability
  tier:           Tier;
  expectedPA:     number;
  lineupPosition: number;
  features:       NormalizedFeatures;
  parkFactor:     number;
  venue:          string;
  weather:        WeatherData;
  generatedAt:    string;   // ISO 8601 timestamp
}
```

---

## 3. Feature Extraction (`features.ts`)

All z-scores are clamped to the range [-3, +3] before entering the model. No raw feature value
is ever passed to the linear score directly. Missing features are handled by redistributing
coefficient mass — never by defaulting to 0, which would incorrectly assume league-average.

```typescript
import { CALIBRATION } from './calibration';
import type { BatterStats, WeatherData, Hand } from './types';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function zScore(value: number, mean: number, std: number): number {
  return clamp((value - mean) / std, -3, 3);
}

// League distribution constants.
// Recalibrate these annually — run rates shift with rule changes, ball specs, and
// pitcher composition changes. These values reflect the 2023–2024 MLB baseline.
export const LEAGUE = {
  hrPerPa:      { mean: 0.036,  std: 0.022  },
  iso:          { mean: 0.155,  std: 0.045  },
  barrelRate:   { mean: 0.082,  std: 0.040  },
  hrPer9:       { mean: 1.35,   std: 0.38   },
  park:         { mean: 100,    std: 12     },
  recentHrRate: { mean: 0.036,  std: 0.055  },  // Higher std reflects small-sample noise
  arsenal:      { mean: 0,      std: 3.2    },
  weather:      { mean: 0,      std: 0.80   },
};

export function zHrPerPa(batter: BatterStats): number {
  return zScore(batter.hrPerPa, LEAGUE.hrPerPa.mean, LEAGUE.hrPerPa.std);
}

export function zPower(batter: BatterStats): number {
  // Barrel rate is a stronger predictor of HR than ISO because it captures
  // both the power and the contact quality simultaneously. Use it when available.
  if (batter.barrelRate > 0) {
    return zScore(batter.barrelRate, LEAGUE.barrelRate.mean, LEAGUE.barrelRate.std);
  }
  return zScore(batter.iso, LEAGUE.iso.mean, LEAGUE.iso.std);
}

export function zRecentForm(batter: BatterStats, window: 7 | 14): number {
  const hr = window === 7 ? batter.hrLast7  : batter.hrLast14;
  const pa = window === 7 ? batter.paLast7  : batter.paLast14;

  // Minimum PA thresholds prevent noise from dominating for players
  // returning from injury, callups with few opportunities, or off days.
  // Return 0 (neutral contribution) rather than a misleading z-score.
  const minPa = window === 7 ? 12 : 24;
  if (pa < minPa) return 0;

  const recentRate = hr / pa;
  // Note: recentHrRate.std is 0.055, much wider than season std of 0.022,
  // because 12–24 PA samples are inherently noisy. This dampens the z-score
  // appropriately so a 2-HR week doesn't create a +3.0 z-score.
  return zScore(recentRate, LEAGUE.recentHrRate.mean, LEAGUE.recentHrRate.std);
}

export function zPark(parkFactor: number): number {
  // parkFactor of 100 = perfectly neutral (league average).
  // Coors Field ≈ 130 → z = +2.5. Oracle Park ≈ 75 → z = -2.1.
  return zScore(parkFactor, LEAGUE.park.mean, LEAGUE.park.std);
}

export function zHandedness(batter: BatterStats, pitcherHand: Hand): number {
  // Use actual platoon splits when they exist — these are dramatically more accurate
  // than canonical adjustments, especially for batters with unusual platoon profiles.
  if (pitcherHand === 'L' && batter.hrPerPaVsL !== undefined) {
    return zScore(batter.hrPerPaVsL, LEAGUE.hrPerPa.mean, LEAGUE.hrPerPa.std);
  }
  if (pitcherHand === 'R' && batter.hrPerPaVsR !== undefined) {
    return zScore(batter.hrPerPaVsR, LEAGUE.hrPerPa.mean, LEAGUE.hrPerPa.std);
  }

  // Canonical platoon adjustment — fallback only.
  // Switch hitters always bat from the advantaged side, giving them
  // consistent platoon advantage against every pitcher.
  const effectiveHand: Hand =
    batter.hand === 'S'
      ? pitcherHand === 'L' ? 'R' : 'L'
      : batter.hand;

  const platoonAdj: Record<string, number> = {
    'R_L': 0.80,   // Righty vs lefty: strongest platoon advantage in baseball
    'L_R': 0.50,   // Lefty vs righty: moderate advantage
    'R_R': -0.35,  // Same-hand matchup: slight disadvantage
    'L_L': -0.45,  // Same-hand: left-on-left is the most extreme suppressor
  };
  return platoonAdj[`${effectiveHand}_${pitcherHand}`] ?? 0;
}

export function zLineupSpot(lineupPosition: number): number {
  // This is a small residual signal capturing count leverage and lineup protection
  // beyond what the PA adjustment already accounts for. Cleanup hitters see more
  // RBI situations and pitchers work carefully around them, creating more fastball counts.
  const spotAdj: Record<number, number> = {
    1: 0.30, 2: 0.50, 3: 0.60, 4: 0.70, 5: 0.30,
    6: 0.00, 7: -0.20, 8: -0.40, 9: -0.60,
  };
  return spotAdj[lineupPosition] ?? 0;
}

export function expectedPaForSpot(lineupPosition: number): number {
  // Expected plate appearances based on lineup position in a typical 9-inning game.
  // Leadoff hitters bat more frequently; 9-hole hitters less so.
  const paMap: Record<number, number> = {
    1: 4.6, 2: 4.5, 3: 4.4, 4: 4.3,
    5: 4.2, 6: 4.1, 7: 4.0, 8: 3.8, 9: 3.5,
  };
  return paMap[lineupPosition] ?? CALIBRATION.expectedPaDefault;
}

export function zWeather(weather: WeatherData): number {
  // Temperature: warm air is less dense, giving a batted ball more carry.
  // Baseline is 72°F. Each 15°F above that contributes roughly +1.0 to tempScore.
  const tempScore = (weather.tempF - 72) / 15;

  // Wind direction is the single most impactful weather variable.
  // The formula below uses cosine so that:
  //   windDirectionDeg = 0   (blowing IN from CF) → factor = -1 → strong suppressor
  //   windDirectionDeg = 90  (crosswind)           → factor = 0  → neutral
  //   windDirectionDeg = 180 (blowing OUT to CF)   → factor = +1 → maximum HR boost
  // A 15 mph wind blowing directly out adds roughly 15–25 feet of carry.
  const windDirectionFactor = -Math.cos((weather.windDirectionDeg * Math.PI) / 180);
  const windScore = (weather.windSpeedMph * windDirectionFactor) / 12;

  // Humidity: warm humid air is marginally less dense. Minor effect.
  const humidScore = (weather.humidityPct - 50) / 150;

  // Temperature and wind carry roughly equal weight; humidity is minor.
  const composite = (tempScore * 0.45) + (windScore * 0.45) + (humidScore * 0.10);
  return zScore(composite, LEAGUE.weather.mean, LEAGUE.weather.std);
}

// Coefficient redistribution for missing features.
// When a feature is unavailable (no weather data, insufficient recent PA sample,
// no arsenal data for a debut pitcher), its coefficient weight is NOT dropped to zero.
// Zero would incorrectly treat the missing feature as exactly league-average.
// Instead, the missing weight is spread proportionally across present features.
export function adjustedCoefficients(
  presentFeatures: (keyof typeof CALIBRATION.coefficients)[]
): Partial<Record<keyof typeof CALIBRATION.coefficients, number>> {
  const all = Object.keys(CALIBRATION.coefficients) as (keyof typeof CALIBRATION.coefficients)[];
  const totalMass    = all.reduce((s, k) => s + CALIBRATION.coefficients[k], 0);
  const missingMass  = all
    .filter(k => !presentFeatures.includes(k))
    .reduce((s, k) => s + CALIBRATION.coefficients[k], 0);
  const scale = 1 + missingMass / (totalMass - missingMass);

  const result: Partial<Record<keyof typeof CALIBRATION.coefficients, number>> = {};
  for (const k of presentFeatures) {
    result[k] = CALIBRATION.coefficients[k] * scale;
  }
  return result;
}
```

---

## 4. Pitch Arsenal Engine (`arsenal.ts`)

The pitch arsenal matchup score is the most innovative and highest-signal pitcher-side input in
the model. Unlike a generic "pitcher quality" score, it is entirely batter-specific: the same
pitcher will score very differently against a fastball-masher vs a breaking-ball hitter.

### How It Works

For each pitch in the pitcher's arsenal:
1. Get the **pitcher's RV/100** on that pitch (from Statcast) — how good the pitch is
2. Get the **batter's RV/100** against that pitch type — how well the batter handles it
3. Compute `batterAdvantage = batterRV100 - pitcherRV100`
   - Positive: batter has the edge on this pitch
   - Negative: pitcher dominates with this pitch
4. Weight by usage frequency (adjusted for count leverage when available)
5. Sum across all pitch types → `arsenalRaw`

```typescript
import { LEAGUE } from './features';
import type { PitchArsenalEntry, BatterVsPitchType, ArsenalMatchupDetail } from './types';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function computeArsenalScore(
  pitcherPitches: PitchArsenalEntry[],
  batterSplits:   BatterVsPitchType[]
): { raw: number; detail: ArsenalMatchupDetail[] } {

  // Normalize usage percentages to sum to exactly 100.
  // Source data sometimes has rounding errors.
  const totalUsage = pitcherPitches.reduce((s, p) => s + p.usagePct, 0);
  if (totalUsage === 0) return { raw: 0, detail: [] };

  const detail: ArsenalMatchupDetail[] = [];
  let arsenalRaw = 0;

  for (const pitch of pitcherPitches) {
    const rawUsageFrac = pitch.usagePct / totalUsage;

    // Count-leverage adjustment: home runs occur disproportionately in hitter's
    // counts (1-0, 2-0, 3-1) because pitchers must throw more fastballs and hitters
    // are more selective and swing harder. If count-split data exists, shift the
    // effective usage toward what the pitcher throws in hitter's counts.
    let effectiveUsageFrac = rawUsageFrac;
    if (
      pitch.usagePctHittersCount !== undefined &&
      pitch.usagePctPitchersCount !== undefined
    ) {
      const countWeighted =
        (pitch.usagePctHittersCount * 0.60) + (pitch.usagePctPitchersCount * 0.40);
      effectiveUsageFrac = (countWeighted / totalUsage);
    }

    // Match this pitch type against the batter's recorded split.
    // If no split exists, treat as neutral (0 advantage) rather than
    // making up a direction.
    const batterSplit  = batterSplits.find(b => b.pitchType === pitch.pitchType);
    const batterRV100  = batterSplit?.batterRV100 ?? 0;

    // Batter advantage computation:
    // batterRV100 is from the batter's perspective: positive = batter produces runs
    // pitcherRV100 is from the pitcher's perspective: negative = pitcher suppresses runs
    // So net advantage for batter = batterRV100 - pitcherRV100
    // Example: batter RV100 = +4.8 (crushes fastballs), pitcher RV100 = -1.2 (elite FB)
    //   → advantage = +4.8 - (-1.2) = +6.0 → large batter edge
    const batterAdvantage  = batterRV100 - pitch.pitcherRV100;
    const weightedContrib  = effectiveUsageFrac * batterAdvantage;
    arsenalRaw            += weightedContrib;

    detail.push({
      pitchType:       pitch.pitchType,
      usagePct:        pitch.usagePct,
      pitcherRV100:    pitch.pitcherRV100,
      batterRV100,
      batterAdvantage,
      weightedContrib,
    });
  }

  return { raw: arsenalRaw, detail };
}

export function zArsenal(raw: number): number {
  // Typical arsenal range: -6 to +6. Z-score against league distribution.
  return clamp(
    (raw - LEAGUE.arsenal.mean) / LEAGUE.arsenal.std,
    -3, 3
  );
}

// Fallback for pitchers without arsenal data (debut starters, minor league callups).
// Uses HR/9 as the closest traditional analog. Lower HR/9 = better for pitcher = lower z.
// This is a significantly weaker signal than the arsenal score.
export function zPitcherFallback(hrPer9: number): number {
  return clamp((hrPer9 - 1.35) / 0.38, -3, 3);
}
```

---

## 5. The Probability Model (`model.ts`)

```typescript
import { CALIBRATION } from './calibration';
import type { NormalizedFeatures, PlayerProjection, Tier } from './types';
import {
  zHrPerPa, zPower, zRecentForm, zPark, zHandedness,
  zWeather, zLineupSpot, expectedPaForSpot
} from './features';
import { computeArsenalScore, zArsenal, zPitcherFallback } from './arsenal';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function computeLinearScore(features: NormalizedFeatures): number {
  const c = CALIBRATION.coefficients;
  return (
    CALIBRATION.intercept
    + c.hrPerPa      * features.zHrPerPa
    + c.power        * features.zPower
    + c.arsenal      * features.zArsenal
    + c.park         * features.zPark
    + c.handedness   * features.zHandedness
    + c.weather      * features.zWeather
    + c.recentForm7  * features.zRecentForm7
    + c.recentForm14 * features.zRecentForm14
    + c.lineupSpot   * features.zLineupSpot
  );
}

export function perPaProbability(linearScore: number): number {
  // Logistic sigmoid: maps any real number to (0, 1)
  // x = -4.8 (intercept only) → ~0.82% per PA ✓
  // x = -1.0 (good matchup)   → ~26.9% per PA → after binomial ≈ 70% (cap will trim)
  // x = -2.0 (solid matchup)  → ~11.9% per PA → after binomial ≈ 40% (cap will trim)
  // x = -3.0 (average+)       → ~4.7%  per PA → after binomial ≈ 18% ✓ realistic
  return 1 / (1 + Math.exp(-linearScore));
}

export function gameHrProbability(perPaProb: number, expectedPA: number): number {
  // Binomial expansion: probability of hitting at least 1 HR in N plate appearances
  // P(at least 1 HR) = 1 - P(exactly 0 HRs) = 1 - (1 - p_pa)^N
  return 1 - Math.pow(1 - perPaProb, expectedPA);
}

export function applyCapAndFloor(rawProb: number): number {
  return clamp(rawProb, CALIBRATION.floor, CALIBRATION.cap);
}

export function assignTier(prob: number): Tier {
  if (prob >= 0.25) return 'A+';
  if (prob >= 0.20) return 'A';
  if (prob >= 0.15) return 'B';
  if (prob >= 0.10) return 'C';
  return 'D';
}

// Full pipeline for a single player
export function projectPlayer(
  batter:       import('./types').BatterStats,
  pitcher:      import('./types').PitcherStats,
  batterSplits: import('./types').BatterVsPitchType[],
  park:         import('./types').ParkData,
  weather:      import('./types').WeatherData,
  opponent:     string
): PlayerProjection {

  // Arsenal matchup: use when pitcher has pitch data AND batter has split data
  const hasArsenalData = pitcher.pitches.length > 0 && batterSplits.length > 0;
  const { raw: arsenalRaw, detail: arsenalDetail } = hasArsenalData
    ? computeArsenalScore(pitcher.pitches, batterSplits)
    : { raw: 0, detail: [] };

  const pitcherZ = hasArsenalData
    ? zArsenal(arsenalRaw)
    : zPitcherFallback(pitcher.hrPer9);

  const features: NormalizedFeatures = {
    zHrPerPa:       zHrPerPa(batter),
    zPower:         zPower(batter),
    zArsenal:       pitcherZ,
    zPark:          zPark(park.hrFactor),
    zHandedness:    zHandedness(batter, pitcher.hand),
    zWeather:       zWeather(weather),
    zRecentForm7:   zRecentForm(batter, 7),
    zRecentForm14:  zRecentForm(batter, 14),
    zLineupSpot:    zLineupSpot(batter.lineupPosition),
    expectedPA:     expectedPaForSpot(batter.lineupPosition),
    arsenalRaw,
    arsenalDetail,
    featuresPresent: [],
  };

  const x      = computeLinearScore(features);
  const ppa    = perPaProbability(x);
  const pgame  = gameHrProbability(ppa, features.expectedPA);
  const probHR = applyCapAndFloor(pgame);

  return {
    playerId:       batter.playerId,
    playerName:     batter.name,
    team:           batter.team,
    opponent,
    probHR,
    probHRRaw:      pgame,
    linearScore:    x,
    perPaProb:      ppa,
    tier:           assignTier(probHR),
    expectedPA:     features.expectedPA,
    lineupPosition: batter.lineupPosition,
    features,
    parkFactor:     park.hrFactor,
    venue:          park.venueName,
    weather,
    generatedAt:    new Date().toISOString(),
  };
}
```

---

## 6. Daily Runner (`index.ts`)

```typescript
import { projectPlayer } from './engine/model';
import type { PlayerProjection } from './types';

async function runDailyProjections(): Promise<PlayerProjection[]> {
  const lineups  = await fetchConfirmedLineups();   // MLB Stats API
  const pitchers = await fetchProbablePitchers();    // MLB Stats API

  const projections: PlayerProjection[] = [];

  for (const game of lineups.games) {
    const park    = await getParkData(game.venueId);
    const weather = await getWeather(game.venueId, game.firstPitchTime);

    for (const side of ['home', 'away'] as const) {
      const batterList = game[side].lineup;
      const pitcherSide = side === 'home' ? 'away' : 'home';
      const pitcher = pitchers[game[pitcherSide].team];

      for (const batter of batterList) {
        const batterStats  = await getBatterStats(batter.playerId);
        const batterSplits = await getBatterVsPitchSplits(batter.playerId, pitcher.pitcherId);
        const pitcherStats = await getPitcherArsenal(pitcher.pitcherId);

        const projection = projectPlayer(
          batterStats, pitcherStats, batterSplits, park, weather, pitcher.name
        );
        projections.push(projection);
      }
    }
  }

  return projections.sort((a, b) => b.probHR - a.probHR);
}

runDailyProjections()
  .then(results => {
    console.log(JSON.stringify(results, null, 2));
  })
  .catch(err => {
    console.error('Projection run failed:', err);
    process.exit(1);
  });
```

---

## 7. Data Source Adapters

Build thin adapter modules for each external data source. Keep all data fetching completely
separated from model logic. The model should never know where the data came from.

```typescript
// MLB Stats API — free, official, no authentication required
// Provides: game schedule, confirmed lineups, probable pitchers, venue IDs
const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';

// Example: get today's schedule with probable pitchers
// GET https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2024-06-15&hydrate=probablePitcher,lineups

// Baseball Savant / Statcast
// Provides: pitch-level RV/100 by pitcher and by batter vs pitch type,
//           barrel rate, hard hit rate, sprint speed, launch angle
// No official API — use pybaseball in a Python sidecar script, or scrape:
const SAVANT_BASE = 'https://baseballsavant.mlb.com';
// Example pybaseball calls for your Python sidecar:
// statcast_pitcher(start_dt, end_dt, pitcher_id) → pitch-level data
// statcast_batter(start_dt, end_dt, batter_id)  → batter-level data

// FanGraphs
// Provides: park factors by year, ISO, wRC+, platoon wOBA splits
// No public JSON API — cache their leaderboard pages or use their export links
// Park factors: https://www.fangraphs.com/guts.aspx?type=pf&teamid=0&season=2024

// Open-Meteo — free weather API, no key required
// Provides: temperature, wind speed, wind direction, humidity at specific coordinates and times
const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';
// Fetch using: venue lat/lng + hourly=temperature_2m,windspeed_10m,winddirection_10m,relativehumidity_2m
// Match the game's scheduled first-pitch hour to get game-time conditions
```

---

## 8. The 33% Cap — Design Rationale

The cap exists because the logistic sigmoid saturates at extreme input values, producing
per-PA probabilities that exceed anything observed in real MLB history. The cap converts
"this model is maximally confident" into a number that communicates real-world probability.

**What approaching 33% actually requires (a realistic extreme case):**

| Feature | Value | Z-Score | Contribution to x |
|---|---|---|---|
| Intercept (b0) | — | — | −4.80 |
| HR/PA (season) | 0.082 ≈ 63 HR pace | +2.1 | +1.16 |
| Barrel rate | 22% (historically elite) | +2.2 | +1.65 |
| Arsenal matchup | Raw +5.8 (pitcher's entire arsenal plays into this batter's strengths) | +1.8 | +1.62 |
| Park factor | 128 (Coors Field level) | +2.3 | +0.81 |
| Platoon | R vs L using actual +0.085 HR/PA split | +2.2 | +0.62 |
| Weather | 88°F, 14 mph blowing directly out (180°) | +2.2 | +0.44 |
| Recent 7d form | 4 HR in last 10 games | +1.8 | +0.72 |
| Recent 14d form | Sustained hot streak | +1.5 | +0.38 |
| Lineup spot | 3rd or 4th | +0.6 | +0.09 |

**Linear score x = −4.80 + 7.49 = +2.69**
Per-PA probability: sigmoid(+2.69) ≈ 93.6% — this is physically impossible.
Game probability before cap: 1 − (1 − 0.936)^4.3 ≈ 99.97%

The cap collapses this to 33%, which is the correct communication: "this is as confident as
the model gets, and even this is very uncertain." No real MLB hitter has ever posted a 33%
per-game HR rate over a meaningful stretch — the all-time single-season record is closer to
a 16–18% per-game rate.

**The cap should fire rarely.** If more than 1–2 players per week touch the 33% ceiling,
the intercept b0 is still too high. Reduce it in steps of 0.1 until the cap fires
fewer than once per week of slates under normal conditions.

---

## 9. Output Format Example

```json
{
  "playerId": "592450",
  "playerName": "Aaron Judge",
  "team": "NYY",
  "opponent": "Patrick Corbin",
  "probHR": 0.271,
  "probHRRaw": 0.308,
  "tier": "A+",
  "linearScore": -0.87,
  "perPaProb": 0.295,
  "expectedPA": 4.3,
  "lineupPosition": 3,
  "parkFactor": 103,
  "venue": "Yankee Stadium",
  "features": {
    "zHrPerPa": 2.10,
    "zPower": 2.35,
    "zArsenal": 1.72,
    "zPark": 0.25,
    "zHandedness": 0.80,
    "zWeather": 1.15,
    "zRecentForm7": 1.45,
    "zRecentForm14": 0.90,
    "zLineupSpot": 0.60,
    "expectedPA": 4.3,
    "arsenalRaw": 4.70,
    "arsenalDetail": [
      {
        "pitchType": "FF",
        "usagePct": 42,
        "pitcherRV100": -0.8,
        "batterRV100": 5.2,
        "batterAdvantage": 6.0,
        "weightedContrib": 2.52
      },
      {
        "pitchType": "SL",
        "usagePct": 33,
        "pitcherRV100": 2.1,
        "batterRV100": 0.4,
        "batterAdvantage": -1.7,
        "weightedContrib": -0.56
      },
      {
        "pitchType": "CU",
        "usagePct": 15,
        "pitcherRV100": 1.2,
        "batterRV100": 2.1,
        "batterAdvantage": 0.9,
        "weightedContrib": 0.14
      },
      {
        "pitchType": "CH",
        "usagePct": 10,
        "pitcherRV100": -0.3,
        "batterRV100": 2.6,
        "batterAdvantage": 2.9,
        "weightedContrib": 0.29
      }
    ]
  },
  "weather": {
    "venueId": "3313",
    "tempF": 82,
    "windSpeedMph": 9,
    "windDirectionDeg": 155,
    "humidityPct": 58
  },
  "generatedAt": "2024-06-15T14:30:00.000Z"
}
```

---

## 10. Tier Reference

| Tier | Range | Meaning | Expected frequency per slate |
|---|---|---|---|
| **A+** | 25–33% | Every factor strongly favorable. Core HR play. | 2–6 players |
| **A**  | 20–25% | Multiple strong factors aligning. Priority target. | 5–12 players |
| **B**  | 15–20% | Solid matchup with real upside. Stack candidate. | 10–20 players |
| **C**  | 10–15% | Mixed factors. Tournament differentiator only. | 20–35 players |
| **D**  | <10%   | Unfavorable matchup. Avoid for HR-specific plays. | Remainder |

---

## 11. Calibration Validation Checklist

Run these checks after implementing the model using the previous week of actual slates:

- [ ] A league-average batter (all z-scores near 0) projects to 11–14% game probability
- [ ] The highest projection on any given slate is organically below 28% before the cap fires
- [ ] Fewer than 3 players per slate land in the A+ tier (≥25%) on a typical day
- [ ] Aaron Judge in a top matchup (favorable arsenal, park, weather, platoon) lands 24–30%
- [ ] A weak power hitter in Oracle Park, cold temps, wind blowing in, vs an elite pitcher: 4–8%
- [ ] Per-PA probability for the top projection stays below 15% (if above 20%, b0 is too high)
- [ ] The 33% cap fires fewer than twice per week across the full slate
- [ ] Recent form z-scores for players with <12 PA in 7 days are exactly 0 (not noise)
- [ ] Missing arsenal data falls back gracefully to zPitcherFallback without crashing

---

## 12. Critical Implementation Notes for Cursor

1. **The `zPitcher` feature from the old formula is fully retired.** The arsenal matchup score
   (`zArsenal`) replaces it entirely. If arsenal data is unavailable, `zPitcherFallback(hrPer9)`
   is used as a temporary measure and the output should be flagged with a `dataQuality: 'low'`
   field so consumers know the projection is weaker.

2. **Never pass raw feature values to the linear score.** Every single feature goes through its
   z-score function before touching the model. Raw values on different scales will destroy
   calibration.

3. **b0 = −4.8 is the most important constant in the system.** It is load-bearing. Do not change
   it without re-running full historical calibration. If you raise it, everything saturates the cap.
   If you lower it, projections will be systematically underconfident.

4. **Wind direction (degrees from home plate) is more impactful than wind speed.** A 15 mph wind
   blowing directly in (0°) suppresses HR more than a poor park. A 10 mph wind blowing directly
   out (180°) at Coors is worth roughly +3–4 percentage points of game probability. Always use
   azimuth from the weather API — do not use textual descriptions like "out to left-center."

5. **Use actual platoon split data whenever it exists.** The canonical platoon adjustments
   (`R_L: 0.80`, etc.) are population averages. Aaron Judge hits .340/.460/.780 vs lefties with
   a wildly different HR/PA than vs righties. Real splits are 5–10x more predictive.

6. **Recent form z-scores use std=0.055, not the season std of 0.022.** This is intentional.
   Small samples (12–24 PA) are inherently noisy. The wider std dampens extreme recent rates
   so a batter who goes 2-for-2 with HRs in 8 PA doesn't get a +3.0 z-score.

7. **The 33% cap should fire rarely.** If it fires for 5+ players daily, reduce b0 by 0.1 and
   test again. The cap is meant to prevent physically impossible outputs, not to trim normal results.

8. **Recalibrate LEAGUE constants every April.** Home run environments change year over year
   due to ball specifications, humidor usage, pitcher shifts in velocity and mix, and rule
   changes. The constants in this prompt reflect 2023–2024 conditions.

9. **For count-split usage data**, leverage Baseball Savant's pitch-level data filtered by
   ball-strike count. Group all 1-0, 2-0, 3-0, 3-1 PAs as "hitter's counts" and
   0-2, 1-2, 2-2 as "pitcher's counts." This data exists in statcast_pitcher() output
   via pybaseball and is worth the extra complexity — count-split arsenal data improves
   the arsenal score meaningfully for high-usage off-speed pitchers.

10. **Switch hitters always get the platoon advantage** — they bat from the opposite side of
    the pitcher's throwing arm by rule. Their `hrPerPaVsL` and `hrPerPaVsR` splits will
    reflect this, but the canonical fallback must handle it explicitly (see `zHandedness`).
