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
import { getBestLineupsForDate } from './lineups.js'

const supabase = () => getServiceClient()

/* ─── helpers ─────────────────────────────────────────────────────── */

function normalize(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function addNameVariant(nameToStatId: Map<string, string>, rawName: string | null | undefined, statId: string) {
  const name = String(rawName ?? '').trim()
  if (!name) return
  nameToStatId.set(normalize(name), statId)
  if (name.includes(',')) {
    const parts = name.split(',').map((s: string) => s.trim()).filter(Boolean)
    if (parts.length >= 2) {
      nameToStatId.set(normalize(`${parts[1]} ${parts[0]}`), statId)
    }
  }
}

function todayET(): string {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/** Distinct slate dates (yesterday through +7d) so each day gets all three model variants in daily_hr_projections. */
async function projectionSlateDates(sb: ReturnType<typeof getServiceClient>, today: string): Promise<string[]> {
  const start = new Date(`${today}T12:00:00Z`)
  start.setUTCDate(start.getUTCDate() - 1)
  const startIso = start.toISOString().slice(0, 10)
  const end = new Date(`${today}T12:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 7)
  const endIso = end.toISOString().slice(0, 10)
  const [{ data: s }, { data: b }] = await Promise.all([
    sb.from('schedule_games').select('date').gte('date', startIso).lte('date', endIso),
    sb.from('bdl_games').select('date').gte('date', startIso).lte('date', endIso),
  ])
  const set = new Set<string>()
  for (const r of [...(s ?? []), ...(b ?? [])]) {
    const d = (r as { date?: string }).date
    if (d) set.add(String(d).slice(0, 10))
  }
  set.add(today)
  return [...set].sort()
}

/**
 * Derive the Eastern Time calendar date from a UTC timestamp string.
 * A West Coast game starting 7 PM PT (10 PM ET) on 3/26 has start_time_utc
 * ~03:00 UTC on 3/27 — but it belongs on the 3/26 slate in ET.
 * Falls back to `fallback` when the input is null/unparseable.
 */
function etDateFromUtc(utcStr: string | null | undefined, fallback: string): string {
  if (!utcStr) return fallback
  try {
    const d = new Date(new Date(utcStr).toLocaleString('en-US', { timeZone: 'America/New_York' }))
    if (isNaN(d.getTime())) return fallback
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${dd}`
  } catch {
    return fallback
  }
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

  // Source 2: stats_exit_velocity, both batting and pitching.
  const { data: evPlayers } = await sb
    .from('stats_exit_velocity')
    .select('player_id, last_name_first_name, role')
    .order('season', { ascending: false })
    .limit(6000)
  for (const r of (evPlayers ?? []) as { player_id: string; last_name_first_name: string | null; role?: string | null }[]) {
    statIdSet.add(r.player_id)
    addNameVariant(nameToStatId, r.last_name_first_name, r.player_id)
  }

  // Source 3: stats_homeruns, both batting and pitching.
  const { data: hrPlayers } = await sb
    .from('stats_homeruns')
    .select('player_id, player_display, role')
    .order('year', { ascending: false })
    .limit(6000)
  for (const r of (hrPlayers ?? []) as { player_id: string; player_display: string | null; role?: string | null }[]) {
    statIdSet.add(r.player_id)
    addNameVariant(nameToStatId, r.player_display, r.player_id)
  }

  // Source 4: stats_standard gives us both hitters and pitchers, with exact display names.
  const { data: standardPlayers } = await sb
    .from('stats_standard')
    .select('player_id, player_name, name_ascii')
    .limit(10000)
  for (const r of (standardPlayers ?? []) as { player_id: string; player_name: string | null; name_ascii: string | null }[]) {
    statIdSet.add(r.player_id)
    addNameVariant(nameToStatId, r.player_name, r.player_id)
    addNameVariant(nameToStatId, r.name_ascii, r.player_id)
  }

  // Source 5: stats_pitch_arsenal is the specific CSV-backed source for pitch-type data.
  const { data: arsenalPlayers } = await sb
    .from('stats_pitch_arsenal')
    .select('player_id, last_name_first_name')
    .order('season', { ascending: false })
    .limit(10000)
  for (const r of (arsenalPlayers ?? []) as { player_id: string; last_name_first_name: string | null }[]) {
    statIdSet.add(r.player_id)
    addNameVariant(nameToStatId, r.last_name_first_name, r.player_id)
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
      team_id: p.team?.id ?? null,
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

  const teamUpdates = rows.filter((r) => r.stat_player_id && r.team_abbrev)
  let teamFixed = 0
  for (const r of teamUpdates) {
    const { error } = await sb
      .from('players')
      .update({ team: r.team_abbrev })
      .eq('stat_player_id', r.stat_player_id!)
      .neq('team', r.team_abbrev!)
    if (!error) teamFixed++
  }
  console.log(`[BDL] synced ${rows.length} players, ${matched} cross-referenced, ${teamFixed} team updates`)
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
    // Use the game's actual ET date derived from its start time, not the date we
    // requested — a late West Coast game may end after midnight UTC which would
    // otherwise bump it onto the next calendar day.
    const gameDate = etDateFromUtc(g.date, date)
    return {
      bdl_game_id: g.id,
      date: gameDate,
      start_time_utc: g.date ?? null,
      home_team_abbrev: g.home_team?.abbreviation ?? '',
      away_team_abbrev: g.away_team?.abbreviation ?? '',
      home_team_name: g.home_team_name ?? g.home_team?.display_name ?? '',
      away_team_name: g.away_team_name ?? g.away_team?.display_name ?? '',
      status,
      scoring_summary: g.scoring_summary ?? null,
      home_score: g.home_team_data?.runs ?? 0,
      away_score: g.away_team_data?.runs ?? 0,
      home_hits: g.home_team_data?.hits ?? 0,
      away_hits: g.away_team_data?.hits ?? 0,
      home_errors: g.home_team_data?.errors ?? 0,
      away_errors: g.away_team_data?.errors ?? 0,
      home_inning_scores: g.home_team_data?.inning_scores ?? [],
      away_inning_scores: g.away_team_data?.inning_scores ?? [],
      current_period: g.period ?? null,
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
  const sb = supabase()
  const { data: gameMeta } = await sb
    .from('bdl_games')
    .select('status')
    .eq('bdl_game_id', bdlGameId)
    .maybeSingle()
  const status = String((gameMeta as { status?: string | null } | null)?.status ?? '').toLowerCase()
  const gameStarted = status !== '' && !/scheduled|pre|not started/.test(status)
  const { count: existingCount } = await sb
    .from('bdl_player_props')
    .select('*', { count: 'exact', head: true })
    .eq('bdl_game_id', bdlGameId)
    .eq('prop_type', 'home_runs')
  if (gameStarted && (existingCount ?? 0) > 0) {
    console.log(`[BDL] preserving pregame props for game ${bdlGameId} (${existingCount} rows)`)
    return { synced: existingCount ?? 0 }
  }

  const requestedVendors = vendors?.length
    ? vendors
    : ['draftkings', 'fanduel', 'fanatics', 'betmgm', 'caesars', 'betrivers']

  const propMap = new Map<string, BdlPlayerProp>()
  for (const vendor of requestedVendors) {
    try {
      const res = await bdlFetch<{ data: BdlPlayerProp[] }>(
        '/mlb/v1/odds/player_props',
        {
          game_id: bdlGameId,
          prop_type: 'home_runs',
          'vendors[]': vendor,
        },
      )
      for (const row of res.data ?? []) {
        const key = [
          row.game_id,
          row.player_id,
          row.vendor,
          row.prop_type,
          row.line_value,
          row.market?.type ?? '',
        ].join('|')
        if (!propMap.has(key)) propMap.set(key, row)
      }
    } catch (e) {
      console.warn(`[BDL] props fetch failed for ${vendor} game ${bdlGameId}:`, e)
    }
  }
  const props = [...propMap.values()]

  // Clear stale props for this game + prop type before inserting fresh
  await sb
    .from('bdl_player_props')
    .delete()
    .eq('bdl_game_id', bdlGameId)
    .eq('prop_type', 'home_runs')

  const rows = props.map((p) => ({
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

/* ─── 6. Bulk BvP sync for today's games ─────────────────────────── */

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

const TEAM_ABBREV_MAP: Record<string, string> = {
  TB: 'TBR', TBR: 'TBR',
  WSH: 'WSN', WSN: 'WSN', WAS: 'WSN',
  AZ: 'ARI', ARI: 'ARI',
  KC: 'KCR', KCR: 'KCR',
  SF: 'SFG', SFG: 'SFG',
  SD: 'SDP', SDP: 'SDP',
  OAK: 'ATH', ATH: 'ATH',
  CWS: 'CHW', CHW: 'CHW',
}

function canonTeam(abbrev: string): string {
  const t = abbrev.trim().toUpperCase()
  return TEAM_ABBREV_MAP[t] ?? t
}

export async function syncMatchupsForTodayGames(): Promise<{ synced: number }> {
  const today = todayET()
  const sb = supabase()
  console.log(`[BDL] bulk BvP sync for ${today}…`)

  const { data: todayGames } = await sb
    .from('bdl_games')
    .select('home_team_abbrev, away_team_abbrev')
    .eq('date', today)
  if (!todayGames?.length) {
    console.log('[BDL] no games today, skipping BvP sync')
    return { synced: 0 }
  }

  const teamPairs: Array<{ batterTeam: string; opponentTeam: string }> = []
  for (const g of todayGames) {
    teamPairs.push(
      { batterTeam: canonTeam(g.home_team_abbrev), opponentTeam: canonTeam(g.away_team_abbrev) },
      { batterTeam: canonTeam(g.away_team_abbrev), opponentTeam: canonTeam(g.home_team_abbrev) },
    )
  }

  const allAbbrevs = (abbrev: string): string[] => {
    const canon = canonTeam(abbrev)
    const variants = new Set<string>([canon, abbrev.toUpperCase()])
    for (const [k, v] of Object.entries(TEAM_ABBREV_MAP)) {
      if (v === canon) variants.add(k)
    }
    return [...variants]
  }

  let totalSynced = 0
  for (const { batterTeam, opponentTeam } of teamPairs) {
    const batterAbbrevs = allAbbrevs(batterTeam)
    const { data: batters } = await sb
      .from('bdl_players')
      .select('bdl_id, team_id')
      .in('team_abbrev', batterAbbrevs)
      .not('bdl_id', 'is', null)
      .limit(40)

    if (!batters?.length) {
      console.log(`[BDL] BvP: no batters found for team ${batterTeam} (tried ${batterAbbrevs.join(',')}), skipping`)
      continue
    }

    const oppAbbrevs = allAbbrevs(opponentTeam)
    const { data: oppTeamRow } = await sb
      .from('bdl_players')
      .select('team_id')
      .in('team_abbrev', oppAbbrevs)
      .not('team_id', 'is', null)
      .limit(1)
      .maybeSingle()
    const oppTeamId = Number((oppTeamRow as any)?.team_id ?? 0)
    if (!oppTeamId) {
      console.log(`[BDL] BvP: no team_id for opponent ${opponentTeam} (tried ${oppAbbrevs.join(',')}), skipping`)
      continue
    }

    console.log(`[BDL] BvP: syncing ${batters.length} batters from ${batterTeam} vs team_id=${oppTeamId}`)
    for (const b of batters as Array<{ bdl_id: number; team_id: number | null }>) {
      try {
        const r = await syncMatchup(b.bdl_id, oppTeamId)
        totalSynced += r.synced
        await sleep(300)
      } catch (e) {
        console.warn(`[BDL] BvP sync error for bdl_id=${b.bdl_id} vs team=${oppTeamId}:`, String(e))
      }
    }
  }

  console.log(`[BDL] bulk BvP sync complete: ${totalSynced} matchup rows`)
  return { synced: totalSynced }
}

/* ─── 7. Full daily sync (GitHub cron ~8 AM ET → POST /bdl/sync/daily) ─ */

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

  // Bulk BvP matchup sync for all today's batters
  const matchups = await syncMatchupsForTodayGames()

  // Run the HR projection engine for today + upcoming slate dates (all model variants per date)
  let projections: Array<{ date: string; computed: number; saved: number }> = []
  try {
    const { runAndSaveProjections } = await import('../hrEngine.js')
    const dates = await projectionSlateDates(sb, today)
    console.log(`[daily-sync] HR projections for ${dates.length} date(s):`, dates.join(', '))
    for (const d of dates) {
      try {
        const r = await runAndSaveProjections(d)
        projections.push({ date: d, ...r })
      } catch (err) {
        console.error(`[daily-sync] runAndSaveProjections failed for ${d}:`, err)
      }
    }
  } catch (e) {
    console.error('[daily-sync] HR projection engine failed:', e)
  }

  // Pre-warm lineup cache for today so first user page load is instant
  try {
    const dates = await projectionSlateDates(sb, today)
    for (const d of dates.slice(0, 3)) {
      await getBestLineupsForDate(sb, d)
    }
    console.log('[daily-sync] lineup cache pre-warmed')
  } catch (e) {
    console.warn('[daily-sync] lineup cache pre-warm failed:', e)
  }

  return { players, games, seasonStats, propsTotal, matchups, projections }
}
