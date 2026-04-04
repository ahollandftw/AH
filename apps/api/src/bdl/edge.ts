import { getServiceClient } from '../supabase.js'

/**
 * Convert American odds → implied probability (0–1).
 * Positive odds (+300): prob = 100 / (odds + 100)
 * Negative odds (-150): prob = |odds| / (|odds| + 100)
 */
export function americanOddsToProb(odds: number): number {
  if (odds >= 0) return 100 / (odds + 100)
  return Math.abs(odds) / (Math.abs(odds) + 100)
}

export type EdgeResult = {
  ourProbability: number
  ourOdds: number
  bookProbability: number
  bookOdds: number
  edge: number
  edgePct: string
  vendor: string
}

/**
 * Calculates the edge between our model's HR probability and a sportsbook's
 * HR odds for a given player in a given game.
 *
 * Edge = ourProbability − bookImpliedProbability
 * Positive edge = our model says the bet is +EV.
 */
export async function calculateEdge(
  statPlayerId: string,
  bdlGameId: number,
  vendor: string,
): Promise<EdgeResult | null> {
  const sb = getServiceClient()

  const { data: game } = await sb
    .from('bdl_games')
    .select('date')
    .eq('bdl_game_id', bdlGameId)
    .maybeSingle()

  const gameDate =
    game?.date != null ? String((game as { date: string }).date).slice(0, 10) : null

  // Get our model probability (default variant for the slate date of this game)
  let projQuery = sb
    .from('daily_hr_projections')
    .select('hr_probability')
    .eq('player_id', statPlayerId)
    .eq('model_variant', 'default')

  if (gameDate) {
    projQuery = projQuery.eq('date', gameDate)
  } else {
    projQuery = projQuery.order('date', { ascending: false }).limit(1)
  }

  const { data: proj } = await projQuery.maybeSingle()

  let ourProb = (proj as { hr_probability: number } | null)?.hr_probability ?? null

  // Fallback to stats-based probability if no daily projection
  if (ourProb == null) {
    const { data: ev } = await sb
      .from('stats_exit_velocity')
      .select('brl_percent, ev95percent, avg_hit_speed, fbld, attempts')
      .eq('role', 'batting')
      .eq('player_id', statPlayerId)
      .order('season', { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data: hr } = await sb
      .from('stats_homeruns')
      .select('hr_total')
      .eq('role', 'batting')
      .eq('player_id', statPlayerId)
      .order('year', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (ev && hr) {
      const brl = Number((ev as Record<string, unknown>).brl_percent) || 0
      const ev95 = Number((ev as Record<string, unknown>).ev95percent) || 0
      const avg = Number((ev as Record<string, unknown>).avg_hit_speed) || 0
      const fbld = Number((ev as Record<string, unknown>).fbld) || 0
      const attempts = Number((ev as Record<string, unknown>).attempts) || 1
      const hrTotal = Number((hr as Record<string, unknown>).hr_total) || 0
      const baseRate = hrTotal / attempts
      const power = 0.35 * brl + 0.25 * ev95 + 0.20 * (avg / 100) + 0.20 * fbld
      ourProb = Math.max(0.01, Math.min(0.60, baseRate * power))
    }
  }

  if (ourProb == null) return null

  // Get sportsbook odds
  const { data: prop } = await sb
    .from('bdl_player_props')
    .select('milestone_odds, over_odds, market_type, vendor')
    .eq('bdl_game_id', bdlGameId)
    .eq('prop_type', 'home_runs')
    .eq('vendor', vendor)
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!prop) return null
  const p = prop as {
    milestone_odds: number | null
    over_odds: number | null
    market_type: string | null
    vendor: string
  }

  // Determine sportsbook odds
  const bookOdds = p.milestone_odds ?? p.over_odds
  if (bookOdds == null) return null

  const bookProb = americanOddsToProb(bookOdds)
  const ourOdds =
    ourProb >= 0.5
      ? Math.round(-(ourProb / (1 - ourProb)) * 100)
      : Math.round(((1 - ourProb) / ourProb) * 100)

  const edge = ourProb - bookProb

  return {
    ourProbability: ourProb,
    ourOdds,
    bookProbability: bookProb,
    bookOdds,
    edge,
    edgePct: `${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)}%`,
    vendor: p.vendor,
  }
}

/**
 * Batch edge calculation for all players in today's games for a given vendor.
 */
export async function calculateEdgesForDate(
  dateIso: string,
  vendor: string,
): Promise<EdgeResult[]> {
  const sb = getServiceClient()

  const { data: props } = await sb
    .from('bdl_player_props')
    .select('bdl_player_id, bdl_game_id, milestone_odds, over_odds, market_type, vendor')
    .eq('prop_type', 'home_runs')
    .eq('vendor', vendor)

  if (!props?.length) return []

  // Cross-reference BDL IDs to stat_player_ids
  const bdlIds = [...new Set(props.map((p: { bdl_player_id: number }) => p.bdl_player_id))]
  const { data: xref } = await sb
    .from('bdl_players')
    .select('bdl_id, stat_player_id')
    .in('bdl_id', bdlIds)
    .not('stat_player_id', 'is', null)

  const xrefMap = new Map(
    (xref ?? []).map((r: { bdl_id: number; stat_player_id: string }) => [
      r.bdl_id,
      r.stat_player_id,
    ]),
  )

  const results: EdgeResult[] = []
  for (const p of props as {
    bdl_player_id: number
    bdl_game_id: number
    milestone_odds: number | null
    over_odds: number | null
    vendor: string
  }[]) {
    const statId = xrefMap.get(p.bdl_player_id)
    if (!statId) continue

    const bookOdds = p.milestone_odds ?? p.over_odds
    if (bookOdds == null) continue

    const edge = await calculateEdge(statId, p.bdl_game_id, vendor)
    if (edge) results.push(edge)
  }

  return results
}
