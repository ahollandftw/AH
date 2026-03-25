export type PlayerStatsDailyRow = {
  id: string
  player_id: number
  player_name: string | null
  team: string | null
  position: string | null
  date: string
  plate_appearances: number
  home_runs: number
  barrels: number
  barrel_rate: number | null
  hard_hit_rate: number | null
  avg_exit_velo: number | null
  fly_ball_rate: number | null
  created_at: string
}

export type PlayerAggregateRow = {
  player_id: number
  player_name: string | null
  team: string | null
  position: string | null
  sample_size_pa: number
  last3_barrel_rate: number | null
  last7_barrel_rate: number | null
  last14_barrel_rate: number | null
  season_barrel_rate: number | null
  last7_hard_hit_rate: number | null
  last7_avg_exit_velo: number | null
  hr_score: number | null
  expected_hr: number | null
  actual_hr: number
  hr_diff: number | null
  low_sample: boolean
  league_avg_barrel_rate: number | null
  barrel_plus: number | null
  updated_at: string
}

export type LeaderboardEntry = PlayerAggregateRow & {
  /** Convenience: same as hr_diff */
  edge?: number
}

export type LeaderboardResponse = {
  last_updated: string
  count: number
  players: LeaderboardEntry[]
}
