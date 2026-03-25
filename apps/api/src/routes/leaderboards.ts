import type { Express, Request, Response } from 'express'
import { getServiceClient } from '../supabase.js'
import type { LeaderboardEntry, LeaderboardResponse } from '../types.js'

function parseIncludeLow(req: Request): boolean {
  return req.query.include_low_sample === 'true'
}

async function fetchAggregates(
  orderColumn: string,
  ascending: boolean,
  includeLow: boolean,
): Promise<LeaderboardResponse> {
  const supabase = getServiceClient()
  const { data: ts } = await supabase
    .from('player_aggregates')
    .select('updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let q = supabase.from('player_aggregates').select('*')
  if (!includeLow) {
    q = q.eq('low_sample', false)
  }
  q = q.order(orderColumn, { ascending, nullsFirst: false })
  const { data, error } = await q
  if (error) throw error
  const players = (data ?? []) as LeaderboardEntry[]
  return {
    last_updated: ts?.updated_at ?? new Date().toISOString(),
    count: players.length,
    players,
  }
}

export function registerLeaderboardRoutes(app: Express) {
  app.get('/leaderboard/hot', async (req, res: Response) => {
    try {
      const r = await fetchAggregates('hr_score', false, parseIncludeLow(req))
      res.json(r)
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.get('/leaderboard/cold', async (req, res: Response) => {
    try {
      const r = await fetchAggregates('hr_score', true, parseIncludeLow(req))
      res.json(r)
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.get('/leaderboard/buy-low', async (req, res: Response) => {
    try {
      const r = await fetchAggregates('hr_diff', true, parseIncludeLow(req))
      res.json(r)
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.get('/leaderboard/sell-high', async (req, res: Response) => {
    try {
      const r = await fetchAggregates('hr_diff', false, parseIncludeLow(req))
      res.json(r)
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })
}
