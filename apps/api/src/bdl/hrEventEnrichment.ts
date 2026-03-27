import type { SupabaseClient } from '@supabase/supabase-js'

/** Align with BDL / schedule team codes for home/away comparison. */
export function canonTeamAbbrev(team: string | null | undefined): string {
  if (!team) return ''
  const t = team.trim().toUpperCase()
  if (t === 'TB' || t === 'TBR') return 'TBR'
  if (t === 'WSH' || t === 'WSN' || t === 'WAS') return 'WSN'
  if (t === 'AZ' || t === 'ARI') return 'ARI'
  if (t === 'KC' || t === 'KCR') return 'KCR'
  if (t === 'SF' || t === 'SFG') return 'SFG'
  if (t === 'SD' || t === 'SDP') return 'SDP'
  if (t === 'OAK' || t === 'ATH') return 'ATH'
  if (t === 'CWS' || t === 'CHW') return 'CHW'
  return t
}

export type HrEventEnrichment = {
  game_date: string | null
  venue: string | null
  batter_team_abbrev: string | null
  pitcher_team_abbrev: string | null
  batter_home_away: 'H' | 'A' | null
  pitcher_home_away: 'H' | 'A' | null
}

export async function buildHrEventEnrichment(
  sb: SupabaseClient,
  bdlGameId: number,
  bdlBatterId: number,
  bdlPitcherId: number | null | undefined,
): Promise<HrEventEnrichment> {
  const { data: game } = await sb
    .from('bdl_games')
    .select('date,venue,home_team_abbrev,away_team_abbrev')
    .eq('bdl_game_id', bdlGameId)
    .maybeSingle()

  const [{ data: batter }, { data: pitcher }] = await Promise.all([
    sb.from('bdl_players').select('team_abbrev').eq('bdl_id', bdlBatterId).maybeSingle(),
    bdlPitcherId
      ? sb.from('bdl_players').select('team_abbrev').eq('bdl_id', bdlPitcherId).maybeSingle()
      : Promise.resolve({ data: null as { team_abbrev: string | null } | null }),
  ])

  const home = canonTeamAbbrev(game?.home_team_abbrev ?? '')
  const away = canonTeamAbbrev(game?.away_team_abbrev ?? '')
  const bTeam = canonTeamAbbrev(batter?.team_abbrev ?? '')
  const pTeam = pitcher ? canonTeamAbbrev(pitcher.team_abbrev ?? '') : ''

  let batter_home_away: 'H' | 'A' | null = null
  let pitcher_home_away: 'H' | 'A' | null = null
  if (home && away && bTeam) {
    if (bTeam === home) batter_home_away = 'H'
    else if (bTeam === away) batter_home_away = 'A'
  }
  if (home && away && pTeam) {
    if (pTeam === home) pitcher_home_away = 'H'
    else if (pTeam === away) pitcher_home_away = 'A'
  }

  return {
    game_date: game?.date ?? null,
    venue: game?.venue ?? null,
    batter_team_abbrev: batter?.team_abbrev ?? null,
    pitcher_team_abbrev: pitcher?.team_abbrev ?? null,
    batter_home_away,
    pitcher_home_away,
  }
}
