import { getServiceClient } from '../supabase.js'
import { bdlFetch, bdlFetchAll, type BdlGame, type BdlPlay, type BdlPlateAppearance } from './client.js'
import { syncGames, syncPlayerProps } from './sync.js'
import { buildHrEventEnrichment } from './hrEventEnrichment.js'
import { syncLineupsForUpcomingGames } from './lineupSync.js'

const POLL_INTERVAL_MS = 2 * 60 * 1000   // 2 minutes during active games
const IDLE_INTERVAL_MS = 15 * 60 * 1000  // 15 minutes when no games active

let timer: ReturnType<typeof setInterval> | null = null
let currentInterval = IDLE_INTERVAL_MS

function todayET(): string {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isGameWindow(): boolean {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const hour = now.getHours()
  return hour >= 11 && hour <= 24 // 11 AM to midnight ET
}

const HR_PATTERNS = [
  /homer/i,
  /home run/i,
  /grand slam/i,
  /homers/i,
]

function isHomeRunPlay(play: BdlPlay): boolean {
  if (!play.scoring_play) return false
  if (!play.text) return false
  return HR_PATTERNS.some((re) => re.test(play.text!))
}

/* ─── HR detection for a single game ─────────────────────────────── */

async function pollGamePlays(bdlGameId: number, lastOrder: number): Promise<number> {
  const sb = getServiceClient()

  let plays: BdlPlay[]
  try {
    plays = await bdlFetchAll<BdlPlay>('/mlb/v1/plays', { game_id: bdlGameId })
  } catch (e) {
    console.error(`[LIVE] failed to fetch plays for game ${bdlGameId}:`, e)
    return lastOrder
  }

  const newPlays = plays.filter((p) => p.order > lastOrder)
  if (!newPlays.length) return lastOrder

  const hrPlays = newPlays.filter(isHomeRunPlay)
  if (!hrPlays.length) return Math.max(lastOrder, ...newPlays.map((p) => p.order))

  // Plate appearances (for pitch-by-pitch detail like hit_distance). One fetch per game poll.
  let plateApps: BdlPlateAppearance[] | null = null
  try {
    const paRes = await bdlFetch<{ data: BdlPlateAppearance[] }>('/mlb/v1/plate_appearances', {
      game_id: bdlGameId,
    })
    plateApps = paRes.data ?? []
  } catch {
    plateApps = null
  }

  // Cross-reference batter IDs
  const batterIds = [...new Set(hrPlays.map((p) => p.batter_id).filter(Boolean))] as number[]
  const { data: xref } = await sb
    .from('bdl_players')
    .select('bdl_id, stat_player_id, full_name')
    .in('bdl_id', batterIds)

  const xrefMap = new Map(
    (xref ?? []).map((r: { bdl_id: number; stat_player_id: string | null; full_name: string }) => [
      r.bdl_id,
      r,
    ]),
  )

  // Cross-reference pitcher IDs to show opposing pitcher + optional pitch detail
  const pitcherIds = [...new Set(hrPlays.map((p) => p.pitcher_id).filter(Boolean))] as number[]
  const { data: pitcherXref } = pitcherIds.length
    ? await sb.from('bdl_players').select('bdl_id, full_name').in('bdl_id', pitcherIds)
    : { data: [] }

  const pitcherMap = new Map(
    (pitcherXref ?? []).map((r: { bdl_id: number; full_name: string }) => [r.bdl_id, r.full_name]),
  )

  const today = todayET()

  for (const play of hrPlays) {
    if (!play.batter_id) continue
    const player = xrefMap.get(play.batter_id)
    const statId = player?.stat_player_id ?? null

    console.log(
      `[LIVE] HR detected: ${player?.full_name ?? `BDL#${play.batter_id}`} ` +
        `(game ${bdlGameId}, inning ${play.inning}) — "${play.text}"`,
    )

    // Insert HR event (ignore duplicates). If DB columns for enrichment aren't present yet,
    // fall back to the minimal insert so live monitoring doesn't break.
    const parsedDistance =
      play.text && /\((\d+)\s*feet\)/i.test(play.text)
        ? Number(play.text.match(/\((\d+)\s*feet\)/i)?.[1] ?? NaN)
        : null
    const distanceFromText = parsedDistance != null && Number.isFinite(parsedDistance) ? parsedDistance : null

    const pa =
      plateApps?.find((pa) => {
        const sameBatter = pa.batter_id === play.batter_id
        const samePitcher = play.pitcher_id != null ? pa.pitcher_id === play.pitcher_id : true
        const sameInning = pa.inning === play.inning
        const isHr = (pa.result ?? '').toLowerCase().includes('home run')
        return sameBatter && samePitcher && sameInning && isHr
      }) ?? null

    const lastPitch = pa?.pitches?.length ? pa.pitches[pa.pitches.length - 1] : null
    const pitchType = play.pitch_type ?? lastPitch?.pitch_type ?? lastPitch?.pitch_type_code ?? null
    const hitDistance = lastPitch?.hit_distance ?? distanceFromText ?? null

    const enrich = await buildHrEventEnrichment(sb, bdlGameId, play.batter_id, play.pitcher_id ?? null, statId)

    try {
      await sb.from('bdl_hr_events').upsert(
        {
          bdl_game_id: bdlGameId,
          bdl_batter_id: play.batter_id,
          stat_player_id: statId,
          bdl_pitcher_id: play.pitcher_id,
          pitcher_name: play.pitcher_id ? (pitcherMap.get(play.pitcher_id) ?? null) : null,
          pitch_type: pitchType,
          hit_distance: hitDistance,
          play_order: play.order,
          play_text: play.text,
          inning: play.inning,
          detected_at: new Date().toISOString(),
          ...enrich,
        },
        { onConflict: 'bdl_game_id,play_order' },
      )
    } catch (e) {
      await sb.from('bdl_hr_events').upsert(
        {
          bdl_game_id: bdlGameId,
          bdl_batter_id: play.batter_id,
          stat_player_id: statId,
          play_order: play.order,
          play_text: play.text,
          inning: play.inning,
          detected_at: new Date().toISOString(),
          ...enrich,
        },
        { onConflict: 'bdl_game_id,play_order' },
      )
    }

    // Validate user picks if we have a cross-referenced stat_player_id
    if (statId) {
      const pickedUsers = await validatePicksForHr(statId, today)
      await notifyLeagueHr(statId, pickedUsers)
    }
  }

  return Math.max(lastOrder, ...newPlays.map((p) => p.order))
}

/* ─── Pick validation ─────────────────────────────────────────────── */

async function validatePicksForHr(statPlayerId: string, dateIso: string): Promise<string[]> {
  const sb = getServiceClient()

  const { data: picks, error } = await sb
    .from('user_daily_picks')
    .select('user_id')
    .eq('player_id', statPlayerId)
    .eq('pick_date', dateIso)
    .is('hit', null)

  if (error || !picks?.length) return []

  console.log(`[LIVE] marking ${picks.length} pick(s) as HIT for ${statPlayerId}`)

  const { error: upErr } = await sb
    .from('user_daily_picks')
    .update({ hit: true })
    .eq('player_id', statPlayerId)
    .eq('pick_date', dateIso)
    .is('hit', null)

  if (upErr) {
    console.error('[LIVE] mark hit update failed:', upErr.message)
    return []
  }

  // Send notifications to users who have hr_notifications enabled
  const userIds = [...new Set(picks.map((p: { user_id: string }) => p.user_id))]
  await sendHrNotifications(userIds, statPlayerId, 'pick')
  return userIds
}

/* ─── Notification dispatch ───────────────────────────────────────── */

async function sendHrNotifications(
  userIds: string[],
  statPlayerId: string,
  mode: 'pick' | 'league',
) {
  const sb = getServiceClient()

  // Get player name
  const { data: player } = await sb
    .from('players')
    .select('name')
    .eq('stat_player_id', statPlayerId)
    .maybeSingle()
  const playerName = (player as { name: string } | null)?.name ?? 'A player'

  // Filter to users who have this notification type enabled
  const settingsQuery = sb
    .from('user_settings')
    .select('user_id')
    .in('user_id', userIds)
  const { data: settings } =
    mode === 'pick'
      ? await settingsQuery.eq('hr_notifications', true)
      : await settingsQuery.eq('hr_notifications_league', true)

  if (!settings?.length) return

  // Check for push tokens
  const notifyUserIds = settings.map((s: { user_id: string }) => s.user_id)
  const { data: tokens } = await sb
    .from('user_push_tokens')
    .select('expo_push_token')
    .in('user_id', notifyUserIds)

  if (!tokens?.length) {
    console.log(`[LIVE] no push tokens for ${notifyUserIds.length} users`)
    return
  }

  // Send via Expo push (best-effort)
  const messages = tokens.map((t: { expo_push_token: string }) => ({
    to: t.expo_push_token,
    title: 'Home Run! ⚾',
    body:
      mode === 'pick'
        ? `${playerName} just hit a home run! Your pick was correct.`
        : `${playerName} just hit a home run.`,
    sound: 'default',
  }))

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    })
    console.log(`[LIVE] sent ${messages.length} push notification(s)`)
  } catch (e) {
    console.error('[LIVE] push send failed:', e)
  }
}

async function notifyLeagueHr(statPlayerId: string, excludeUserIds: string[]) {
  const sb = getServiceClient()
  const { data: settings } = await sb
    .from('user_settings')
    .select('user_id')
    .eq('hr_notifications_league', true)
  const allLeagueUsers = (settings ?? []).map((s: { user_id: string }) => s.user_id)
  const leagueOnly = allLeagueUsers.filter((id) => !excludeUserIds.includes(id))
  if (!leagueOnly.length) return
  await sendHrNotifications(leagueOnly, statPlayerId, 'league')
}

/* ─── Mark remaining picks as misses after game ends ──────────────── */

async function finalizeGamePicks(dateIso: string) {
  const sb = getServiceClient()

  // Any picks for today that are still null (no HR detected) → miss
  const { error } = await sb
    .from('user_daily_picks')
    .update({ hit: false })
    .eq('pick_date', dateIso)
    .is('hit', null)

  if (error) {
    console.error('[LIVE] finalize picks error:', error.message)
  } else {
    console.log(`[LIVE] finalized remaining picks for ${dateIso} as misses`)
  }
}

/* ─── Main poll cycle ─────────────────────────────────────────────── */

async function pollCycle() {
  if (!isGameWindow()) {
    setPollingRate(IDLE_INTERVAL_MS)
    return
  }

  const today = todayET()

  // Refresh game statuses from API
  await syncGames(today)

  // Sync lineups for games starting within the next 75 minutes
  try {
    await syncLineupsForUpcomingGames(75)
  } catch (e) {
    console.error('[LIVE] lineup sync failed:', e)
  }

  const sb = getServiceClient()
  const { data: games } = await sb
    .from('bdl_games')
    .select('bdl_game_id, status, last_play_order')
    .eq('date', today)

  if (!games?.length) {
    setPollingRate(IDLE_INTERVAL_MS)
    return
  }

  const activeGames = games.filter((g: { status: string }) =>
    /progress|live|in progress/i.test(g.status),
  )

  if (activeGames.length === 0) {
    // Check if all games are final → finalize picks
    const allFinal = games.every((g: { status: string }) =>
      /final|completed|postponed|canceled/i.test(g.status),
    )
    if (allFinal && games.length > 0) {
      await finalizeGamePicks(today)
    }
    setPollingRate(IDLE_INTERVAL_MS)
    return
  }

  // Active games found → fast polling
  setPollingRate(POLL_INTERVAL_MS)

  // Refresh props for active games
  for (const g of activeGames) {
    const game = g as { bdl_game_id: number; status: string; last_play_order: number }
    try {
      await syncPlayerProps(game.bdl_game_id)
    } catch (e) {
      console.error(`[LIVE] props sync failed for game ${game.bdl_game_id}:`, e)
    }
  }

  // Poll play-by-play for each active game
  for (const g of activeGames) {
    const game = g as { bdl_game_id: number; status: string; last_play_order: number }
    try {
      const newOrder = await pollGamePlays(game.bdl_game_id, game.last_play_order ?? 0)
      if (newOrder > (game.last_play_order ?? 0)) {
        await sb
          .from('bdl_games')
          .update({ last_play_order: newOrder })
          .eq('bdl_game_id', game.bdl_game_id)
      }
    } catch (e) {
      console.error(`[LIVE] play poll failed for game ${game.bdl_game_id}:`, e)
    }
  }
}

function setPollingRate(ms: number) {
  if (ms === currentInterval) return
  currentInterval = ms
  if (timer) {
    clearInterval(timer)
    timer = setInterval(() => void pollCycle(), ms)
  }
  console.log(`[LIVE] polling rate → ${ms / 1000}s`)
}

/* ─── Public start/stop ───────────────────────────────────────────── */

export function startLiveMonitor() {
  if (timer) return
  console.log('[LIVE] monitor started')
  currentInterval = isGameWindow() ? POLL_INTERVAL_MS : IDLE_INTERVAL_MS
  timer = setInterval(() => void pollCycle(), currentInterval)
  // Run once immediately
  void pollCycle()
}

export function stopLiveMonitor() {
  if (!timer) return
  clearInterval(timer)
  timer = null
  console.log('[LIVE] monitor stopped')
}
