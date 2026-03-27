/**
 * Lineup sync: fetches lineups from BDL and caches them in bdl_lineups.
 *
 * - Runs during live monitor poll for games starting within the next hour
 * - Stores confirmed lineups once BDL publishes them
 * - Yesterday's lineup is available as a projected lineup for today's games
 */
import { getServiceClient } from '../supabase.js'
import { bdlFetch } from './client.js'

type BdlLineupEntry = {
  player: { id: number; full_name: string; position: string }
  batting_order: number | null
  position: string | null
}
type BdlLineupResponse = {
  data?: { home?: BdlLineupEntry[]; away?: BdlLineupEntry[] }
}

function todayET(): string {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Sync lineups for a single BDL game and persist to bdl_lineups.
 * Returns true if lineup was available and saved.
 */
export async function syncLineupForGame(
  bdlGameId: number,
  date: string,
  homeAbbrev: string,
  awayAbbrev: string,
): Promise<boolean> {
  let bdlLineup: BdlLineupResponse
  try {
    bdlLineup = await bdlFetch<BdlLineupResponse>('/mlb/v1/lineups', { game_id: bdlGameId })
  } catch {
    return false
  }

  const homeEntries = bdlLineup?.data?.home ?? []
  const awayEntries = bdlLineup?.data?.away ?? []
  if (!homeEntries.length && !awayEntries.length) return false

  const sb = getServiceClient()

  const allBdlIds = [
    ...new Set([
      ...homeEntries.map((e) => e.player?.id).filter(Boolean),
      ...awayEntries.map((e) => e.player?.id).filter(Boolean),
    ]),
  ] as number[]

  const { data: xref } = allBdlIds.length
    ? await sb.from('bdl_players').select('bdl_id, stat_player_id, full_name').in('bdl_id', allBdlIds)
    : { data: [] as any[] }

  const xrefMap = new Map<number, { stat_player_id: string | null; full_name: string | null }>(
    (xref ?? []).map((r: any) => [Number(r.bdl_id), { stat_player_id: r.stat_player_id, full_name: r.full_name }]),
  )

  const rows: any[] = []

  for (const e of homeEntries) {
    const xr = xrefMap.get(e.player?.id)
    rows.push({
      bdl_game_id: bdlGameId,
      date,
      team_abbrev: homeAbbrev.toUpperCase(),
      side: 'home',
      bdl_player_id: e.player?.id ?? null,
      stat_player_id: xr?.stat_player_id ?? null,
      full_name: e.player?.full_name ?? xr?.full_name ?? null,
      position: e.position ?? e.player?.position ?? null,
      batting_order: e.batting_order ?? null,
      is_confirmed: true,
      fetched_at: new Date().toISOString(),
    })
  }
  for (const e of awayEntries) {
    const xr = xrefMap.get(e.player?.id)
    rows.push({
      bdl_game_id: bdlGameId,
      date,
      team_abbrev: awayAbbrev.toUpperCase(),
      side: 'away',
      bdl_player_id: e.player?.id ?? null,
      stat_player_id: xr?.stat_player_id ?? null,
      full_name: e.player?.full_name ?? xr?.full_name ?? null,
      position: e.position ?? e.player?.position ?? null,
      batting_order: e.batting_order ?? null,
      is_confirmed: true,
      fetched_at: new Date().toISOString(),
    })
  }

  if (rows.length > 0) {
    const { error } = await sb.from('bdl_lineups').upsert(rows, {
      onConflict: 'bdl_game_id,bdl_player_id,side',
      ignoreDuplicates: false,
    })
    if (error) {
      console.error(`[lineup-sync] upsert failed for game ${bdlGameId}:`, error.message)
      return false
    }
  }

  console.log(`[lineup-sync] Cached ${rows.length} players for game ${bdlGameId}`)
  return true
}

/**
 * Check all today's games and sync lineups for those starting within
 * the next `windowMinutes` (default 75 min) that don't have confirmed lineups yet.
 */
export async function syncLineupsForUpcomingGames(windowMinutes = 75): Promise<number> {
  const sb = getServiceClient()
  const today = todayET()

  const { data: games } = await sb
    .from('bdl_games')
    .select('bdl_game_id, date, start_time_utc, home_team_abbrev, away_team_abbrev, status')
    .eq('date', today)

  if (!games?.length) return 0

  const now = Date.now()
  const windowMs = windowMinutes * 60 * 1000
  let synced = 0

  for (const g of games as any[]) {
    const status = String(g.status ?? '').toLowerCase()
    if (/final|completed|postponed|canceled/i.test(status)) continue

    const startUtc = g.start_time_utc ? new Date(g.start_time_utc).getTime() : 0
    if (!startUtc) continue

    const timeUntilStart = startUtc - now
    if (timeUntilStart > windowMs || timeUntilStart < -30 * 60 * 1000) continue

    const { count } = await sb
      .from('bdl_lineups')
      .select('id', { count: 'exact', head: true })
      .eq('bdl_game_id', g.bdl_game_id)
      .eq('is_confirmed', true)

    if ((count ?? 0) >= 9) continue

    const ok = await syncLineupForGame(
      g.bdl_game_id,
      today,
      g.home_team_abbrev,
      g.away_team_abbrev,
    )
    if (ok) synced++
  }

  if (synced > 0) {
    console.log(`[lineup-sync] Synced lineups for ${synced} upcoming game(s)`)
  }
  return synced
}

/**
 * Sync lineups for ALL today's games (used during daily sync).
 */
export async function syncAllLineupsForDate(dateOverride?: string): Promise<number> {
  const sb = getServiceClient()
  const date = dateOverride ?? todayET()

  const { data: games } = await sb
    .from('bdl_games')
    .select('bdl_game_id, home_team_abbrev, away_team_abbrev')
    .eq('date', date)

  if (!games?.length) return 0
  let synced = 0

  for (const g of games as any[]) {
    const ok = await syncLineupForGame(g.bdl_game_id, date, g.home_team_abbrev, g.away_team_abbrev)
    if (ok) synced++
  }

  return synced
}
