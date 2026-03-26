import { getServiceClient } from '../supabase.js'
import {
  bdlFetch,
  bdlFetchAll,
  type BdlGame,
  type BdlPlayer,
  type BdlPlayerProp,
  type BdlSeasonStats,
  type BdlMatchup,
} from './client.js'

const supabase = () => getServiceClient()

/* ─── helpers ─────────────────────────────────────────────────────── */

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function todayET(): string {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/* ─── 1. Sync active players + build cross-reference ──────────────── */

export async function syncActivePlayers(): Promise<{ synced: number; matched: number }> {
  console.log('[BDL] syncing active players…')
  const players = await bdlFetchAll<BdlPlayer>('/mlb/v1/players/active')
  console.log(`[BDL] fetched ${players.length} active players`)

  const sb = supabase()

  // Build a comprehensive lookup from ALL sources of player data
  // statPlayerIdSet: all known stat_player_ids
  // nameToStatId: normalized name → stat_player_id
  const statIdSet = new Set<string>()
  const nameToStatId = new Map<string, string>()

  // Source 1: players table (names like "Aaron Judge")
  const { data: ourPlayers } = await sb
    .from('players')
    .select('stat_player_id, name, team')
    .limit(5000)
  for (const p of (ourPlayers ?? []) as { stat_player_id: string; name: string; team: string | null }[]) {
    statIdSet.add(p.stat_player_id)
    nameToStatId.set(normalize(p.name), p.stat_player_id)
    // Also add reversed "First Last" → "last first" in case stored as "Last, First"
    if (p.name.includes(',')) {
      const parts = p.name.split(',').map((s: string) => s.trim())
      nameToStatId.set(normalize(`${parts[1]} ${parts[0]}`), p.stat_player_id)
    }
  }

  // Source 2: stats_exit_velocity (names like "Judge, Aaron" in last_name_first_name)
  const { data: evPlayers } = await sb
    .from('stats_exit_velocity')
    .select('player_id, last_name_first_name')
    .eq('role', 'batting')
    .order('season', { ascending: false })
    .limit(3000)
  for (const r of (evPlayers ?? []) as { player_id: string; last_name_first_name: string | null }[]) {
    statIdSet.add(r.player_id)
    if (r.last_name_first_name) {
      // "Judge, Aaron" → normalized "judge aaron" AND "aaron judge"
      nameToStatId.set(normalize(r.last_name_first_name), r.player_id)
      const parts = r.last_name_first_name.split(',').map((s: string) => s.trim())
      if (parts.length >= 2) {
        nameToStatId.set(normalize(`${parts[1]} ${parts[0]}`), r.player_id)
      }
    }
  }

  // Source 3: stats_homeruns (player_display like "Judge, Aaron")
  const { data: hrPlayers } = await sb
    .from('stats_homeruns')
    .select('player_id, player_display')
    .eq('role', 'batting')
    .order('year', { ascending: false })
    .limit(3000)
  for (const r of (hrPlayers ?? []) as { player_id: string; player_display: string | null }[]) {
    statIdSet.add(r.player_id)
    if (r.player_display) {
      nameToStatId.set(normalize(r.player_display), r.player_id)
      const parts = r.player_display.split(',').map((s: string) => s.trim())
      if (parts.length >= 2) {
        nameToStatId.set(normalize(`${parts[1]} ${parts[0]}`), r.player_id)
      }
    }
  }

  console.log(`[BDL] cross-ref pool: ${statIdSet.size} stat IDs, ${nameToStatId.size} name variants`)

  let matched = 0
  const rows = players.map((p) => {
    let statId: string | null = null

    // Strategy 1: BDL integer ID matches a Statcast ID directly
    const idStr = String(p.id)
    if (statIdSet.has(idStr)) {
      statId = idStr
    }

    // Strategy 2: exact full_name match ("Aaron Judge" → "aaron judge")
    if (!statId) {
      statId = nameToStatId.get(normalize(p.full_name)) ?? null
    }

    // Strategy 3: "First Last" constructed from parts
    if (!statId) {
      statId = nameToStatId.get(normalize(`${p.first_name} ${p.last_name}`)) ?? null
    }

    // Strategy 4: "Last, First" constructed from parts
    if (!statId) {
      statId = nameToStatId.get(normalize(`${p.last_name} ${p.first_name}`)) ?? null
    }

    // Strategy 5: "Last, First" with comma
    if (!statId) {
      statId = nameToStatId.get(normalize(`${p.last_name}, ${p.first_name}`)) ?? null
    }

    if (statId) matched++

    return {
      bdl_id: p.id,
      stat_player_id: statId,
      full_name: p.full_name,
      first_name: p.first_name,
      last_name: p.last_name,
      team_abbrev: p.team?.abbreviation ?? null,
      position: p.position,
      bats_throws: p.bats_throws,
      synced_at: new Date().toISOString(),
    }
  })

  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb
      .from('bdl_players')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'bdl_id' })
    if (error) console.error('[BDL] player upsert error:', error.message)
  }

  console.log(`[BDL] synced ${rows.length} players, ${matched} cross-referenced`)
  return { synced: rows.length, matched }
}

/* ─── 2. Sync games for a date ────────────────────────────────────── */

export async function syncGames(
  dateIso?: string,
): Promise<{ synced: number; active: number }> {
  const date = dateIso ?? todayET()
  console.log(`[BDL] syncing games for ${date}…`)

  const games = await bdlFetchAll<BdlGame>('/mlb/v1/games', {
    'dates[]': date,
    season_type: 'regular',
  })

  const sb = supabase()
  let active = 0

  const rows = games.map((g) => {
    const status = g.status ?? 'Scheduled'
    if (/progress|live/i.test(status)) active++
    return {
      bdl_game_id: g.id,
      date,
      home_team_abbrev: g.home_team?.abbreviation ?? '',
      away_team_abbrev: g.away_team?.abbreviation ?? '',
      home_team_name: g.home_team_name ?? g.home_team?.display_name ?? '',
      away_team_name: g.away_team_name ?? g.away_team?.display_name ?? '',
      status,
      home_score: g.home_team_data?.runs ?? 0,
      away_score: g.away_team_data?.runs ?? 0,
      venue: g.venue ?? null,
      season: g.season,
      synced_at: new Date().toISOString(),
    }
  })

  if (rows.length) {
    const { error } = await sb
      .from('bdl_games')
      .upsert(rows, { onConflict: 'bdl_game_id' })
    if (error) console.error('[BDL] games upsert error:', error.message)
  }

  console.log(`[BDL] synced ${rows.length} games, ${active} active`)
  return { synced: rows.length, active }
}

/* ─── 3. Sync 2026 season stats ───────────────────────────────────── */

export async function syncSeasonStats(
  season = 2026,
): Promise<{ synced: number }> {
  console.log(`[BDL] syncing ${season} season stats…`)

  const stats = await bdlFetchAll<BdlSeasonStats>('/mlb/v1/season_stats', {
    season,
    season_type: 'regular',
  })

  const sb = supabase()
  const rows = stats.map((s) => ({
    bdl_player_id: s.player.id,
    season: s.season,
    team_name: s.team_name,
    batting_gp: s.batting_gp, batting_ab: s.batting_ab, batting_r: s.batting_r,
    batting_h: s.batting_h, batting_avg: s.batting_avg, batting_2b: s.batting_2b,
    batting_3b: s.batting_3b, batting_hr: s.batting_hr, batting_rbi: s.batting_rbi,
    batting_tb: s.batting_tb, batting_bb: s.batting_bb, batting_so: s.batting_so,
    batting_sb: s.batting_sb, batting_obp: s.batting_obp, batting_slg: s.batting_slg,
    batting_ops: s.batting_ops, batting_war: s.batting_war,
    pitching_gp: s.pitching_gp, pitching_gs: s.pitching_gs, pitching_w: s.pitching_w,
    pitching_l: s.pitching_l, pitching_era: s.pitching_era, pitching_sv: s.pitching_sv,
    pitching_ip: s.pitching_ip, pitching_h: s.pitching_h, pitching_er: s.pitching_er,
    pitching_hr: s.pitching_hr, pitching_bb: s.pitching_bb, pitching_whip: s.pitching_whip,
    pitching_k: s.pitching_k, pitching_k_per_9: s.pitching_k_per_9,
    pitching_war: s.pitching_war,
    synced_at: new Date().toISOString(),
  }))

  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb
      .from('bdl_season_stats')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'bdl_player_id,season' })
    if (error) console.error('[BDL] season stats upsert error:', error.message)
  }

  console.log(`[BDL] synced ${rows.length} season stat rows`)
  return { synced: rows.length }
}

/* ─── 4. Sync matchup (batter vs opposing team) ──────────────────── */

export async function syncMatchup(
  bdlPlayerId: number,
  opponentTeamId: number,
): Promise<{ synced: number }> {
  const res = await bdlFetch<{ data: BdlMatchup[] }>('/mlb/v1/players/versus', {
    player_id: bdlPlayerId,
    opponent_team_id: opponentTeamId,
  })

  const sb = supabase()
  const rows = (res.data ?? []).map((m) => ({
    bdl_player_id: m.player.id,
    opponent_bdl_player_id: m.opponent_player.id,
    opponent_team_id: m.opponent_team.id,
    at_bats: m.at_bats, hits: m.hits, doubles: m.doubles, triples: m.triples,
    home_runs: m.home_runs, rbi: m.rbi, walks: m.walks, strikeouts: m.strikeouts,
    avg: m.avg, obp: m.obp, slg: m.slg, ops: m.ops,
    synced_at: new Date().toISOString(),
  }))

  if (rows.length) {
    const { error } = await sb
      .from('bdl_matchups')
      .upsert(rows, { onConflict: 'bdl_player_id,opponent_bdl_player_id' })
    if (error) console.error('[BDL] matchup upsert error:', error.message)
  }

  return { synced: rows.length }
}

/* ─── 5. Sync player props for a game ─────────────────────────────── */

export async function syncPlayerProps(
  bdlGameId: number,
  vendors?: string[],
): Promise<{ synced: number }> {
  const params: Record<string, string | string[] | number | undefined> = {
    game_id: bdlGameId,
    prop_type: 'home_runs',
  }
  if (vendors?.length) params['vendors[]'] = vendors

  const res = await bdlFetch<{ data: BdlPlayerProp[] }>(
    '/mlb/v1/odds/player_props',
    params,
  )

  const sb = supabase()

  // Clear stale props for this game + prop type before inserting fresh
  await sb
    .from('bdl_player_props')
    .delete()
    .eq('bdl_game_id', bdlGameId)
    .eq('prop_type', 'home_runs')

  const rows = (res.data ?? []).map((p) => ({
    bdl_game_id: p.game_id,
    bdl_player_id: p.player_id,
    vendor: p.vendor,
    prop_type: p.prop_type,
    line_value: p.line_value,
    market_type: p.market?.type ?? null,
    over_odds: p.market?.over_odds ?? null,
    under_odds: p.market?.under_odds ?? null,
    milestone_odds: p.market?.odds ?? null,
    fetched_at: new Date().toISOString(),
  }))

  if (rows.length) {
    const { error } = await sb.from('bdl_player_props').insert(rows)
    if (error) console.error('[BDL] props insert error:', error.message)
  }

  return { synced: rows.length }
}

/* ─── 6. Full daily sync (called at 10 AM CT) ────────────────────── */

export async function runDailySync(): Promise<Record<string, unknown>> {
  const players = await syncActivePlayers()
  const games = await syncGames()
  const seasonStats = await syncSeasonStats(2026)

  // Sync props for each game today
  const today = todayET()
  const sb = supabase()
  const { data: todayGames } = await sb
    .from('bdl_games')
    .select('bdl_game_id')
    .eq('date', today)
  let propsTotal = 0
  for (const g of todayGames ?? []) {
    const r = await syncPlayerProps(g.bdl_game_id)
    propsTotal += r.synced
  }

  return { players, games, seasonStats, propsTotal }
}
