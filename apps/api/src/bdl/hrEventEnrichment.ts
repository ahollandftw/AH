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

/** Map players.team (may be city name or abbrev) to a 2–3 letter code when possible. */
function abbrevFromPlayersTeam(team: string | null | undefined): string {
  if (!team) return ''
  const t = team.trim()
  const u = t.toUpperCase()
  if (/^[A-Z]{2,4}$/.test(u)) return canonTeamAbbrev(u)
  const hints: [RegExp, string][] = [
    [/YANKEE/i, 'NYY'],
    [/DODGER/i, 'LAD'],
    [/ANGEL/i, 'LAA'],
    [/ASTRO/i, 'HOU'],
    [/GIANT/i, 'SFG'],
    [/PADRE/i, 'SDP'],
    [/RAY/i, 'TBR'],
    [/NATIONAL/i, 'WSN'],
    [/MET/i, 'NYM'],
    [/CUB/i, 'CHC'],
    [/WHITE SOX/i, 'CHW'],
    [/GUARDIAN/i, 'CLE'],
    [/ROCKIE/i, 'COL'],
    [/BREWER/i, 'MIL'],
    [/TWIN/i, 'MIN'],
    [/CARDINAL/i, 'STL'],
    [/MARINER/i, 'SEA'],
    [/RANGER/i, 'TEX'],
    [/BLUE JAY/i, 'TOR'],
    [/PHILLIE/i, 'PHI'],
    [/BRAVE/i, 'ATL'],
    [/ORIOLE/i, 'BAL'],
    [/RED SOX/i, 'BOS'],
    [/REDS\b/i, 'CIN'],
    [/TIGER/i, 'DET'],
    [/ROYAL/i, 'KCR'],
    [/MARLIN/i, 'MIA'],
    [/PIRATE/i, 'PIT'],
    [/DIAMONDBACK|D-BACK/i, 'ARI'],
    [/ATHLETIC/i, 'ATH'],
  ]
  for (const [re, ab] of hints) {
    if (re.test(t)) return ab
  }
  return ''
}

export async function buildHrEventEnrichment(
  sb: SupabaseClient,
  bdlGameId: number,
  bdlBatterId: number,
  bdlPitcherId: number | null | undefined,
  statPlayerId?: string | null,
): Promise<HrEventEnrichment> {
  const { data: game } = await sb
    .from('bdl_games')
    .select('date,venue,home_team_abbrev,away_team_abbrev')
    .eq('bdl_game_id', bdlGameId)
    .maybeSingle()

  const [{ data: batter }, { data: pitcher }, { data: playerRow }] = await Promise.all([
    sb.from('bdl_players').select('team_abbrev').eq('bdl_id', bdlBatterId).maybeSingle(),
    bdlPitcherId
      ? sb.from('bdl_players').select('team_abbrev').eq('bdl_id', bdlPitcherId).maybeSingle()
      : Promise.resolve({ data: null as { team_abbrev: string | null } | null }),
    statPlayerId
      ? sb.from('players').select('team').eq('stat_player_id', statPlayerId).maybeSingle()
      : Promise.resolve({ data: null as { team: string | null } | null }),
  ])

  const home = canonTeamAbbrev(game?.home_team_abbrev ?? '')
  const away = canonTeamAbbrev(game?.away_team_abbrev ?? '')
  let bTeam = canonTeamAbbrev(batter?.team_abbrev ?? '')
  if (playerRow?.team) {
    const fromStat = abbrevFromPlayersTeam(playerRow.team)
    const invalidVsGame =
      Boolean(home && away && bTeam && bTeam !== home && bTeam !== away)
    if (invalidVsGame && fromStat && (fromStat === home || fromStat === away)) {
      bTeam = fromStat
    } else if (!bTeam) {
      bTeam = (fromStat || canonTeamAbbrev(playerRow.team)) || ''
    }
  }

  let batter_home_away: 'H' | 'A' | null = null
  if (home && away && bTeam) {
    if (bTeam === home) batter_home_away = 'H'
    else if (bTeam === away) batter_home_away = 'A'
  }

  // Pitcher and batter are always on opposite teams in an MLB PA.
  let pitcher_home_away: 'H' | 'A' | null = null
  if (batter_home_away === 'H') pitcher_home_away = 'A'
  else if (batter_home_away === 'A') pitcher_home_away = 'H'
  else if (home && away) {
    const pTeam = pitcher ? canonTeamAbbrev(pitcher.team_abbrev ?? '') : ''
    if (pTeam === home) pitcher_home_away = 'H'
    else if (pTeam === away) pitcher_home_away = 'A'
  }

  return {
    game_date: game?.date ?? null,
    venue: game?.venue ?? null,
    batter_team_abbrev: bTeam || batter?.team_abbrev || null,
    pitcher_team_abbrev: pitcher?.team_abbrev ?? null,
    batter_home_away,
    pitcher_home_away,
  }
}
