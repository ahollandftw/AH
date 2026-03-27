/** MLB home ballparks (lat/lon). Keys match normalized team codes (see normalizeMlbHomeTeam). */

export type BallparkInfo = {
  stadium: string
  lat: number
  lon: number
}

const ALIASES: Record<string, string> = {
  AZ: 'ARI',
  KC: 'KCR',
  TB: 'TBR',
  SD: 'SDP',
  SF: 'SFG',
  WAS: 'WSN',
  WSH: 'WSN',
  OAK: 'ATH',
  CWS: 'CHW',
}

/** Normalize raw abbreviations to keys in BALLPARKS (matches team palette codes). */
export function normalizeMlbHomeTeam(team: string | null | undefined): string | null {
  if (!team) return null
  const key = team.trim().toUpperCase()
  if (key === 'TB' || key === 'TBR') return 'TBR'
  if (key === 'WSH' || key === 'WSN' || key === 'WAS') return 'WSN'
  if (key === 'AZ' || key === 'ARI') return 'ARI'
  if (key === 'KC' || key === 'KCR') return 'KCR'
  if (key === 'SD' || key === 'SDP') return 'SDP'
  if (key === 'SF' || key === 'SFG') return 'SFG'
  if (key === 'OAK' || key === 'ATH') return 'ATH'
  if (key === 'CWS' || key === 'CHW') return 'CHW'
  return ALIASES[key] ?? key
}

export const BALLPARKS: Record<string, BallparkInfo> = {
  ATL: { stadium: 'Truist Park', lat: 33.8908, lon: -84.4678 },
  BAL: { stadium: 'Oriole Park at Camden Yards', lat: 39.2838, lon: -76.6216 },
  BOS: { stadium: 'Fenway Park', lat: 42.3467, lon: -71.0972 },
  CHC: { stadium: 'Wrigley Field', lat: 41.9484, lon: -87.6553 },
  CHW: { stadium: 'Guaranteed Rate Field', lat: 41.83, lon: -87.6338 },
  CIN: { stadium: 'Great American Ball Park', lat: 39.0979, lon: -84.5082 },
  CLE: { stadium: 'Progressive Field', lat: 41.4962, lon: -81.6852 },
  COL: { stadium: 'Coors Field', lat: 39.756, lon: -104.9942 },
  DET: { stadium: 'Comerica Park', lat: 42.339, lon: -83.0485 },
  HOU: { stadium: 'Minute Maid Park', lat: 29.7572, lon: -95.3556 },
  KCR: { stadium: 'Kauffman Stadium', lat: 39.0517, lon: -94.4803 },
  LAA: { stadium: 'Angel Stadium', lat: 33.8003, lon: -117.8827 },
  LAD: { stadium: 'Dodger Stadium', lat: 34.0739, lon: -118.24 },
  MIA: { stadium: 'loanDepot park', lat: 25.7781, lon: -80.2197 },
  MIL: { stadium: 'American Family Field', lat: 43.028, lon: -87.9712 },
  MIN: { stadium: 'Target Field', lat: 44.9817, lon: -93.2781 },
  NYM: { stadium: 'Citi Field', lat: 40.7571, lon: -73.8458 },
  NYY: { stadium: 'Yankee Stadium', lat: 40.8296, lon: -73.9262 },
  ATH: { stadium: 'Sutter Health Park', lat: 38.5805, lon: -121.5135 },
  PHI: { stadium: 'Citizens Bank Park', lat: 39.9061, lon: -75.1665 },
  PIT: { stadium: 'PNC Park', lat: 40.4469, lon: -80.0057 },
  SDP: { stadium: 'Petco Park', lat: 32.7073, lon: -117.1566 },
  SFG: { stadium: 'Oracle Park', lat: 37.7786, lon: -122.3893 },
  SEA: { stadium: 'T-Mobile Park', lat: 47.5914, lon: -122.3325 },
  STL: { stadium: 'Busch Stadium', lat: 38.6226, lon: -90.1928 },
  TBR: { stadium: 'Tropicana Field', lat: 27.7682, lon: -82.6534 },
  TEX: { stadium: 'Globe Life Field', lat: 32.7512, lon: -97.0832 },
  TOR: { stadium: 'Rogers Centre', lat: 43.6414, lon: -79.3894 },
  WSN: { stadium: 'Nationals Park', lat: 38.873, lon: -77.0074 },
  ARI: { stadium: 'Chase Field', lat: 33.4453, lon: -112.0667 },
}

export function getBallparkForHomeTeam(homeTeamAbbrev: string | null | undefined): BallparkInfo | null {
  const k = normalizeMlbHomeTeam(homeTeamAbbrev)
  if (!k) return null
  return BALLPARKS[k] ?? null
}
