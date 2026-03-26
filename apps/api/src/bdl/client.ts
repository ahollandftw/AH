import { config } from '../config.js'

const BASE = 'https://api.balldontlie.io'

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function bdlFetch<T = unknown>(
  path: string,
  params?: Record<string, string | string[] | number | undefined>,
): Promise<T> {
  const url = new URL(`${BASE}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, item)
      } else {
        url.searchParams.set(k, String(v))
      }
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: config.bdlApiKey() },
  })

  if (res.status === 429) {
    console.warn('[BDL] rate-limited, waiting 5s…')
    await sleep(5000)
    return bdlFetch(path, params)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`BDL ${res.status} ${path}: ${body}`)
  }

  return res.json() as Promise<T>
}

type Paginated<T> = { data: T[]; meta?: { next_cursor?: number | null } }

export async function bdlFetchAll<T = unknown>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T[]> {
  const all: T[] = []
  let cursor: number | undefined

  do {
    const p: Record<string, string | number | undefined> = {
      ...params,
      per_page: 100,
      cursor,
    }
    const res = await bdlFetch<Paginated<T>>(path, p)
    all.push(...res.data)
    cursor = res.meta?.next_cursor ?? undefined
    if (cursor != null) await sleep(250)
  } while (cursor != null)

  return all
}

/* ─── BDL response types ──────────────────────────────────────────── */

export type BdlTeam = {
  id: number
  slug: string
  abbreviation: string
  display_name: string
  short_display_name: string
  name: string
  location: string
  league: string
  division: string
}

export type BdlPlayer = {
  id: number
  first_name: string
  last_name: string
  full_name: string
  debut_year: number | null
  jersey: string
  college: string
  position: string
  active: boolean
  birth_place: string
  dob: string
  age: number | null
  height: string
  weight: string
  draft: string
  bats_throws: string
  team: BdlTeam
}

export type BdlGame = {
  id: number
  home_team_name: string
  away_team_name: string
  home_team: BdlTeam
  away_team: BdlTeam
  season: number
  postseason: boolean
  season_type: string
  date: string
  home_team_data: { hits: number; runs: number; errors: number; inning_scores?: number[] } | null
  away_team_data: { hits: number; runs: number; errors: number; inning_scores?: number[] } | null
  period: number | null
  venue: string
  status: string
  scoring_summary?: {
    play: string
    inning: string
    period: string
    away_score: number
    home_score: number
  }[]
}

export type BdlPlay = {
  game_id: number
  order: number
  type: string | null
  text: string | null
  home_score: number
  away_score: number
  inning: number
  inning_type: string | null
  scoring_play: boolean
  score_value: number | null
  outs: number | null
  balls?: number | null
  strikes?: number | null
  batter_id: number | null
  pitcher_id: number | null
  pitch_type?: string | null
  pitch_velocity?: number | null
  hit_coordinate_x?: number | null
  hit_coordinate_y?: number | null
  trajectory?: string | null
}

export type BdlPitchDetail = {
  pitch_type_code?: string | null
  pitch_type?: string | null
  hit_distance?: number | null
}

export type BdlPlateAppearance = {
  batter_id: number
  pitcher_id: number
  inning: number
  half_inning?: string | null
  result?: string | null
  pitches?: BdlPitchDetail[]
}

export type BdlSeasonStats = {
  player: BdlPlayer
  team_name: string
  season: number
  postseason: boolean
  season_type: string
  batting_gp: number; batting_ab: number; batting_r: number; batting_h: number
  batting_avg: number; batting_2b: number; batting_3b: number; batting_hr: number
  batting_rbi: number; batting_tb: number; batting_bb: number; batting_so: number
  batting_sb: number; batting_obp: number; batting_slg: number; batting_ops: number
  batting_war: number
  pitching_gp: number; pitching_gs: number; pitching_w: number; pitching_l: number
  pitching_era: number; pitching_sv: number; pitching_ip: number; pitching_h: number
  pitching_er: number; pitching_hr: number; pitching_bb: number; pitching_whip: number
  pitching_k: number; pitching_k_per_9: number; pitching_war: number
}

export type BdlMatchup = {
  player: BdlPlayer
  opponent_player: BdlPlayer
  opponent_team: BdlTeam
  at_bats: number | null
  hits: number | null
  doubles: number | null
  triples: number | null
  home_runs: number | null
  rbi: number | null
  walks: number | null
  strikeouts: number | null
  avg: number | null
  obp: number | null
  slg: number | null
  ops: number | null
}

export type BdlPlayerProp = {
  id: number
  game_id: number
  player_id: number
  vendor: string
  prop_type: string
  line_value: string
  market: {
    type: 'over_under' | 'milestone'
    over_odds?: number | null
    under_odds?: number | null
    odds?: number | null
  }
  updated_at: string
}
