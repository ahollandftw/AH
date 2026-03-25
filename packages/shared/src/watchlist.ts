import type { SupabaseClient } from '@supabase/supabase-js'

export type UserSettings = {
  globalAlertsEnabled: boolean
}

/** playerId is the Statcast id string (e.g. "660271"), matching CSV player_id. */
export type WatchlistPlayer = {
  playerId: string
  slug: string
  name: string
  team: string | null
  position: string | null
  imageUrl: string | null
}

export async function getOrCreateUserSettings(
  supabase: SupabaseClient,
): Promise<UserSettings> {
  const { data: user } = await supabase.auth.getUser()
  const userId = user.user?.id
  if (!userId) {
    return { globalAlertsEnabled: true }
  }

  const { data, error } = await supabase
    .from('user_settings')
    .select('global_alerts_enabled')
    .eq('user_id', userId)
    .maybeSingle()

  if (!error && data) {
    return { globalAlertsEnabled: Boolean(data.global_alerts_enabled) }
  }

  const { error: upsertError } = await supabase
    .from('user_settings')
    .upsert({ user_id: userId, global_alerts_enabled: true })

  if (upsertError) {
    return { globalAlertsEnabled: true }
  }
  return { globalAlertsEnabled: true }
}

export async function setGlobalAlertsEnabled(
  supabase: SupabaseClient,
  enabled: boolean,
) {
  const { data: user } = await supabase.auth.getUser()
  const userId = user.user?.id
  if (!userId) return
  await supabase
    .from('user_settings')
    .upsert({ user_id: userId, global_alerts_enabled: enabled })
}

/**
 * Resolve a Statcast id ("660271") or slug ("shohei-ohtani") to players.stat_player_id.
 */
export async function resolveStatPlayerId(
  supabase: SupabaseClient,
  key: string,
): Promise<string | null> {
  const k = key.trim()
  if (!k) return null
  if (/^\d+$/.test(k)) {
    const { data } = await supabase
      .from('players')
      .select('stat_player_id')
      .eq('stat_player_id', k)
      .maybeSingle()
    if (data?.stat_player_id) return data.stat_player_id
  }
  const { data } = await supabase
    .from('players')
    .select('stat_player_id')
    .eq('slug', k.toLowerCase())
    .maybeSingle()
  return data?.stat_player_id ?? null
}

export async function listWatchlistPlayers(
  supabase: SupabaseClient,
): Promise<WatchlistPlayer[]> {
  const { data: user } = await supabase.auth.getUser()
  const userId = user.user?.id
  if (!userId) return []

  const { data, error } = await supabase
    .from('watchlist_players')
    .select(
      'player_id, players:player_id (stat_player_id,slug,name,team,position,image_url)',
    )
    .eq('user_id', userId)

  if (error || !data) return []

  return data
    .map((row: any) => row.players)
    .filter(Boolean)
    .map((p: any) => ({
      playerId: p.stat_player_id,
      slug: p.slug,
      name: p.name,
      team: p.team ?? null,
      position: p.position ?? null,
      imageUrl: p.image_url ?? null,
    }))
}

/** Add by Statcast id or slug (e.g. "660271" or "shohei-ohtani"). */
export async function addToWatchlistByPlayerKey(
  supabase: SupabaseClient,
  playerKey: string,
) {
  const { data: user } = await supabase.auth.getUser()
  const userId = user.user?.id
  if (!userId) return

  const statId = await resolveStatPlayerId(supabase, playerKey)
  if (!statId) return

  await supabase
    .from('watchlist_players')
    .insert({ user_id: userId, player_id: statId })
}

/** @deprecated Use addToWatchlistByPlayerKey — still resolves slug or Statcast id. */
export async function addToWatchlistBySlug(
  supabase: SupabaseClient,
  playerSlug: string,
) {
  return addToWatchlistByPlayerKey(supabase, playerSlug)
}

/** playerId must be players.stat_player_id (Statcast string). */
export async function removeFromWatchlist(
  supabase: SupabaseClient,
  playerId: string,
) {
  const { data: user } = await supabase.auth.getUser()
  const userId = user.user?.id
  if (!userId) return

  await supabase
    .from('watchlist_players')
    .delete()
    .eq('user_id', userId)
    .eq('player_id', playerId)
}
