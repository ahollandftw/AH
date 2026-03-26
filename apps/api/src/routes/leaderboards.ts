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

  // ── Stats tab: homers list (year totals + today%) ──────────────────
  app.get('/leaderboard/homers', async (req, res: Response) => {
    try {
      const dateIso = String(req.query.date ?? '').trim()
      const days = Number(req.query.days ?? '1') || 1
      const limit = Number(req.query.limit ?? '100') || 100

      // Default date = app "display date" in ET
      const computedDateIso =
        dateIso ||
        (() => {
          const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
          const y = d.getFullYear()
          const m = String(d.getMonth() + 1).padStart(2, '0')
          const dd = String(d.getDate()).padStart(2, '0')
          return `${y}-${m}-${dd}`
        })()

      const seasonPrimary =
        Number(req.query.season ?? new Date(`${computedDateIso}T00:00:00Z`).getUTCFullYear()) || 0
      let seasonUsed = seasonPrimary

      const now = Date.now()
      const from = new Date(now - days * 24 * 60 * 60 * 1000).toISOString()

      const supabase = getServiceClient()

      // HR events in the selected window; aggregate to latest event per hitter.
      // Optional enrichment fields may not exist yet in DB, so we fall back gracefully.
      let hrEvents: any[] = []
      try {
            const { data, error } = await supabase
          .from('bdl_hr_events')
          .select('stat_player_id,bdl_pitcher_id,pitcher_name,pitch_type,hit_distance,detected_at')
          .not('stat_player_id', 'is', null)
          .gte('detected_at', from)
          .order('detected_at', { ascending: false })
          .limit(5000)
        if (error) throw error
        hrEvents = data ?? []
      } catch {
        const { data, error } = await supabase
          .from('bdl_hr_events')
          .select('stat_player_id,detected_at')
          .not('stat_player_id', 'is', null)
          .gte('detected_at', from)
          .order('detected_at', { ascending: false })
          .limit(5000)
        if (error) throw error
        hrEvents = data ?? []
      }

      const latestByPlayer = new Map<string, any>()
      for (const ev of (hrEvents ?? []) as any[]) {
        const pid = String(ev.stat_player_id ?? '')
        if (!pid) continue
        if (!latestByPlayer.has(pid)) latestByPlayer.set(pid, ev)
      }

      const statIds = Array.from(latestByPlayer.keys())

      if (!statIds.length) {
        res.json({ last_updated: new Date().toISOString(), date: computedDateIso, count: 0, players: [] })
        return
      }

      const [{ data: players }, { data: yearHrs }, { data: yearAtt }, { data: todayProbs }] = await Promise.all([
        supabase
          .from('players')
          .select('stat_player_id,name,team,position')
          .in('stat_player_id', statIds)
          .limit(statIds.length),
        supabase
          .from('stats_homeruns')
          .select('player_id,hr_total')
          .eq('role', 'batting')
          .eq('type', 'adj_xhr')
          .eq('year', seasonUsed)
          .in('player_id', statIds),
        supabase
          .from('stats_exit_velocity')
          .select('player_id,attempts,brl_percent,ev95percent,avg_hit_speed,fbld')
          .eq('role', 'batting')
          .eq('season', seasonUsed)
          .in('player_id', statIds),
        supabase
          .from('daily_hr_projections')
          .select('player_id,hr_probability')
          .eq('date', computedDateIso)
          .in('player_id', statIds),
      ])

      const playerMap = new Map((players ?? []).map((p: any) => [String(p.stat_player_id), p]))
      let hrMap = new Map((yearHrs ?? []).map((r: any) => [String(r.player_id), Number(r.hr_total) || 0]))
      let batterMap = new Map(
        (yearAtt ?? []).map((r: any) => [
          String(r.player_id),
          {
            attempts: Number(r.attempts) || 0,
            brl_percent: r.brl_percent != null ? Number(r.brl_percent) : 0,
            ev95percent: r.ev95percent != null ? Number(r.ev95percent) : 0,
            avg_hit_speed: r.avg_hit_speed != null ? Number(r.avg_hit_speed) : 0,
            fbld: r.fbld != null ? Number(r.fbld) : 0,
          },
        ]),
      )
      const todayMap = new Map((todayProbs ?? []).map((r: any) => [String(r.player_id), r.hr_probability != null ? Number(r.hr_probability) : null]))

      // If daily_hr_projections isn't populated, we compute a simplified opponent-adjusted
      // HR probability using our existing stats tables + the opposing pitcher's HR allowed.

      // Automatic 2026 -> 2025 fallback (matches ProjectionsPage behavior).
      // If the target season's HR totals or AB inputs are missing, use 2025.
      if (seasonUsed === 2026) {
        const hasHrTotals = (yearHrs ?? []).some((r: any) => Number(r.hr_total) > 0)
        const hasAbInputs = (yearAtt ?? []).some((r: any) => Number(r.attempts) > 0)
        if (!hasHrTotals || !hasAbInputs) {
          seasonUsed = 2025
          const [{ data: yearHrsFallback }, { data: yearAttFallback }] = await Promise.all([
            supabase
              .from('stats_homeruns')
              .select('player_id,hr_total')
              .eq('role', 'batting')
              .eq('type', 'adj_xhr')
              .eq('year', seasonUsed)
              .in('player_id', statIds),
            supabase
              .from('stats_exit_velocity')
              .select('player_id,attempts,brl_percent,ev95percent,avg_hit_speed,fbld')
              .eq('role', 'batting')
              .eq('season', seasonUsed)
              .in('player_id', statIds),
          ])

          hrMap = new Map(
            (yearHrsFallback ?? []).map((r: any) => [String(r.player_id), Number(r.hr_total) || 0]),
          )
          batterMap = new Map(
            (yearAttFallback ?? []).map((r: any) => [
              String(r.player_id),
              {
                attempts: Number(r.attempts) || 0,
                brl_percent: r.brl_percent != null ? Number(r.brl_percent) : 0,
                ev95percent: r.ev95percent != null ? Number(r.ev95percent) : 0,
                avg_hit_speed: r.avg_hit_speed != null ? Number(r.avg_hit_speed) : 0,
                fbld: r.fbld != null ? Number(r.fbld) : 0,
              },
            ]),
          )
        }
      }

      const pitcherIds = Array.from(
        new Set(
          statIds
            .map((pid) => latestByPlayer.get(pid)?.bdl_pitcher_id ?? null)
            .filter((x) => x != null),
        ),
      ) as number[]

      const pitcherHrMap = new Map<string, number>()
      if (pitcherIds.length) {
        try {
          const { data: pRows } = await supabase
            .from('bdl_season_stats')
            .select('bdl_player_id,pitching_hr')
            .eq('season', seasonUsed)
            .in('bdl_player_id', pitcherIds)
          for (const pr of pRows ?? []) {
            const key = String(pr.bdl_player_id)
            pitcherHrMap.set(key, pr.pitching_hr != null ? Number(pr.pitching_hr) : 20)
          }
        } catch {
          // ignore: simplified probability will use default pitcher factor
        }
      }

      const rows = statIds.map((pid) => {
        const p = playerMap.get(pid)
        const latest = latestByPlayer.get(pid)
        const hrTotal = hrMap.get(pid) ?? 0
        const batter = batterMap.get(pid)
        const attempts = batter?.attempts ?? 0
        const hrRate = attempts > 0 ? hrTotal / attempts : null
        let todayProb = todayMap.get(pid) ?? null

        // Fallback: compute model-like probability using power score + pitcher factor.
        // (No matchup pitch-usage component, because we don't have it here.)
        if (todayProb == null) {
          const brl = batter?.brl_percent ?? 0
          const ev95 = batter?.ev95percent ?? 0
          const avg = batter?.avg_hit_speed ?? 0
          const fbld = batter?.fbld ?? 0

          // If we have no meaningful batting input, leave as null.
          if (attempts > 0 && (brl > 0 || ev95 > 0 || avg > 0 || fbld > 0 || hrTotal > 0)) {
            const baseRate = hrTotal / attempts
            const powerScore = 0.35 * brl + 0.25 * ev95 + 0.20 * (avg / 100) + 0.20 * fbld

            const pitcherId = latest?.bdl_pitcher_id != null ? String(latest.bdl_pitcher_id) : null
            const pitcherHr = pitcherId ? pitcherHrMap.get(pitcherId) ?? 20 : 20
            const pitcherFactor = pitcherHr / 20

            let prob = baseRate * powerScore * pitcherFactor
            prob = Math.max(0.01, Math.min(0.6, prob))
            todayProb = prob
          }
        }

        return {
          stat_player_id: pid,
          player_name: p?.name ?? null,
          team: p?.team ?? null,
          position: p?.position ?? null,
          opponent_pitcher: latest?.pitcher_name ?? null,
          pitch_type: latest?.pitch_type ?? null,
          distance: latest?.hit_distance ?? null,
          hr_total_year: hrTotal,
          hr_rate: hrRate, // HR / AB (attempts)
          today_probability: todayProb,
          today_pct: todayProb != null && Number.isFinite(todayProb) ? todayProb * 100 : null,
        }
      })

      rows.sort((a, b) => {
        const A = a.today_probability ?? -1
        const B = b.today_probability ?? -1
        if (A !== B) return B - A
        return (b.hr_total_year ?? 0) - (a.hr_total_year ?? 0)
      })

      res.json({
        last_updated: new Date().toISOString(),
        date: computedDateIso,
        season: seasonUsed,
        count: rows.length,
        players: rows.slice(0, limit),
      })
    } catch (e) {
      console.error('[leaderboard/homers] failed:', e)
      res.status(500).json({
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      })
    }
  })
}
