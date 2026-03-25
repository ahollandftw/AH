export type TeamPalette = {
  primary: string
  secondary: string
  accent: string
  bg: string
  surface: string
  text: string
}

export const DEFAULT_THEME: TeamPalette = {
  primary: '#D90429',
  secondary: '#EDF2F4',
  accent: '#1D3557',
  bg: '#061329',
  surface: '#0E223F',
  text: '#F8FBFF',
}

const T: Record<string, TeamPalette> = {
  ARI: { primary: '#A71930', secondary: '#E3D4AD', accent: '#000000', bg: '#12070A', surface: '#2A1217', text: '#F8F4E9' },
  ATL: { primary: '#CE1141', secondary: '#FFFFFF', accent: '#13274F', bg: '#0D162E', surface: '#18294A', text: '#F8FBFF' },
  BAL: { primary: '#DF4601', secondary: '#FFFFFF', accent: '#000000', bg: '#110A06', surface: '#2A170D', text: '#FFF5EE' },
  BOS: { primary: '#BD3039', secondary: '#FFFFFF', accent: '#0C2340', bg: '#0A152B', surface: '#172947', text: '#F8FBFF' },
  CHC: { primary: '#0E3386', secondary: '#FFFFFF', accent: '#CC3433', bg: '#071128', surface: '#102447', text: '#F4F8FF' },
  CHW: { primary: '#111111', secondary: '#FFFFFF', accent: '#C4CED4', bg: '#0A0A0A', surface: '#1A1A1A', text: '#F8F8F8' },
  CIN: { primary: '#C6011F', secondary: '#FFFFFF', accent: '#000000', bg: '#130608', surface: '#2A1014', text: '#FFF6F7' },
  CLE: { primary: '#E31937', secondary: '#FFFFFF', accent: '#0C2340', bg: '#081426', surface: '#132846', text: '#F7FAFF' },
  COL: { primary: '#333366', secondary: '#C4CED4', accent: '#000000', bg: '#0C0C15', surface: '#1B1B2E', text: '#F0F1F8' },
  DET: { primary: '#0C2340', secondary: '#FFFFFF', accent: '#FA4616', bg: '#071223', surface: '#132640', text: '#F8FBFF' },
  HOU: { primary: '#EB6E1F', secondary: '#FFFFFF', accent: '#002D62', bg: '#071226', surface: '#152A49', text: '#F8FBFF' },
  KCR: { primary: '#004687', secondary: '#FFFFFF', accent: '#BD9B60', bg: '#061226', surface: '#12294C', text: '#F8FBFF' },
  LAA: { primary: '#BA0021', secondary: '#FFFFFF', accent: '#003263', bg: '#071124', surface: '#122744', text: '#F8FBFF' },
  LAD: { primary: '#005A9C', secondary: '#FFFFFF', accent: '#EF3E42', bg: '#061126', surface: '#12284A', text: '#F8FBFF' },
  MIA: { primary: '#00A3E0', secondary: '#FFFFFF', accent: '#EF3340', bg: '#061522', surface: '#123045', text: '#F3FBFF' },
  MIL: { primary: '#12284B', secondary: '#FFC52F', accent: '#FFFFFF', bg: '#081023', surface: '#162A4D', text: '#FFF9E9' },
  MIN: { primary: '#002B5C', secondary: '#FFFFFF', accent: '#D31145', bg: '#081022', surface: '#15294A', text: '#F7FAFF' },
  NYM: { primary: '#002D72', secondary: '#FFFFFF', accent: '#FF5910', bg: '#071126', surface: '#12284C', text: '#F8FBFF' },
  NYY: { primary: '#0C2340', secondary: '#FFFFFF', accent: '#C4CED4', bg: '#081023', surface: '#142844', text: '#F8FBFF' },
  ATH: { primary: '#003831', secondary: '#EFB21E', accent: '#FFFFFF', bg: '#06110F', surface: '#102822', text: '#F6FFF8' },
  PHI: { primary: '#E81828', secondary: '#FFFFFF', accent: '#002D72', bg: '#071224', surface: '#132848', text: '#F8FBFF' },
  PIT: { primary: '#FDB827', secondary: '#FFFFFF', accent: '#27251F', bg: '#121109', surface: '#2A2513', text: '#FFF9E9' },
  SDP: { primary: '#2F241D', secondary: '#FFC425', accent: '#FFFFFF', bg: '#100D0A', surface: '#251E19', text: '#FFF9E9' },
  SFG: { primary: '#FD5A1E', secondary: '#FFFFFF', accent: '#27251F', bg: '#120B08', surface: '#2A1710', text: '#FFF8F3' },
  SEA: { primary: '#005C5C', secondary: '#FFFFFF', accent: '#C4CED4', bg: '#061415', surface: '#103033', text: '#F4FFFF' },
  STL: { primary: '#C41E3A', secondary: '#FFFFFF', accent: '#0C2340', bg: '#081226', surface: '#162A4B', text: '#F8FBFF' },
  TBR: { primary: '#092C5C', secondary: '#FFFFFF', accent: '#8FBCE6', bg: '#071224', surface: '#142A49', text: '#F7FBFF' },
  TEX: { primary: '#003278', secondary: '#FFFFFF', accent: '#C0111F', bg: '#071125', surface: '#12294B', text: '#F7FBFF' },
  TOR: { primary: '#134A8E', secondary: '#FFFFFF', accent: '#1D2D5C', bg: '#071224', surface: '#142B4C', text: '#F8FBFF' },
  WSN: { primary: '#AB0003', secondary: '#FFFFFF', accent: '#14225A', bg: '#081226', surface: '#152A4C', text: '#F8FBFF' },
}

const TEAM_ALIASES: Record<string, string> = {
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

export function normalizeTeamCode(team: string | null | undefined): string | null {
  if (!team) return null
  const key = team.trim().toUpperCase()
  return TEAM_ALIASES[key] ?? key
}

export function paletteForTeam(team: string | null | undefined): TeamPalette {
  const code = normalizeTeamCode(team)
  if (!code) return DEFAULT_THEME
  return T[code] ?? DEFAULT_THEME
}

export const FAVORITE_TEAM_OPTIONS = [
  'ARI','ATL','BAL','BOS','CHC','CHW','CIN','CLE','COL','DET','HOU','KCR','LAA','LAD',
  'MIA','MIL','MIN','NYM','NYY','ATH','PHI','PIT','SDP','SFG','SEA','STL','TBR','TEX','TOR','WSN',
] as const
