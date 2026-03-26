import type { Express } from 'express'
import {
  runDailySync,
  syncActivePlayers,
  syncGames,
  syncSeasonStats,
  syncMatchup,
  syncPlayerProps,
} from '../bdl/sync.js'
import { startLiveMonitor, stopLiveMonitor } from '../bdl/liveMonitor.js'
import { calculateEdge, calculateEdgesForDate } from '../bdl/edge.js'
import { getServiceClient } from '../supabase.js'

export function registerBdlRoutes(app: Express) {
  const canonTeam = (team: string): string => {
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
  /* ── Daily sync (called by cron or manually) ─────────────────── */

  app.post('/bdl/sync/daily', async (_req, res) => {
    try {
      const result = await runDailySync()
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.post('/bdl/sync/players', async (_req, res) => {
    try {
      const result = await syncActivePlayers()
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.post('/bdl/sync/games', async (req, res) => {
    try {
      const date = typeof req.body?.date === 'string' ? req.body.date : undefined
      const result = await syncGames(date)
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.post('/bdl/sync/season-stats', async (req, res) => {
    try {
      const season = Number(req.body?.season) || 2026
      const result = await syncSeasonStats(season)
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.post('/bdl/sync/matchup', async (req, res) => {
    try {
      const playerId = Number(req.body?.player_id)
      const teamId = Number(req.body?.opponent_team_id)
      if (!playerId || !teamId) {
        res.status(400).json({ error: 'player_id and opponent_team_id required' })
        return
      }
      const result = await syncMatchup(playerId, teamId)
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.post('/bdl/sync/props', async (req, res) => {
    try {
      const gameId = Number(req.body?.game_id)
      if (!gameId) {
        res.status(400).json({ error: 'game_id required' })
        return
      }
      const result = await syncPlayerProps(gameId, req.body?.vendors)
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  /* ── Live monitor control ────────────────────────────────────── */

  app.post('/bdl/live/start', (_req, res) => {
    startLiveMonitor()
    res.json({ ok: true, status: 'started' })
  })

  app.post('/bdl/live/stop', (_req, res) => {
    stopLiveMonitor()
    res.json({ ok: true, status: 'stopped' })
  })

  /* ── Edge calculation ────────────────────────────────────────── */

  app.get('/bdl/edge', async (req, res) => {
    try {
      const statPlayerId = String(req.query.player_id ?? '')
      const bdlGameId = Number(req.query.game_id ?? 0)
      const vendor = String(req.query.vendor ?? 'draftkings')
      if (!statPlayerId || !bdlGameId) {
        res.status(400).json({ error: 'player_id and game_id required' })
        return
      }
      const edge = await calculateEdge(statPlayerId, bdlGameId, vendor)
      res.json({ data: edge })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.get('/bdl/edges', async (req, res) => {
    try {
      const date = String(req.query.date ?? '')
      const vendor = String(req.query.vendor ?? 'draftkings')
      if (!date) {
        res.status(400).json({ error: 'date required' })
        return
      }
      const edges = await calculateEdgesForDate(date, vendor)
      res.json({ data: edges })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  /* ── Matchup data for UI ─────────────────────────────────────── */

  app.get('/bdl/matchup-card', async (req, res) => {
    try {
      const statPlayerId = String(req.query.player_id ?? '').trim()
      const opponentTeam = canonTeam(String(req.query.opponent_team ?? ''))
      const pitcherNameQ = String(req.query.pitcher_name ?? '').trim().toLowerCase()
      if (!statPlayerId || !opponentTeam) {
        res.status(400).json({ error: 'player_id and opponent_team required' })
        return
      }

      const sb = getServiceClient()
      const { data: batterXref, error: xErr } = await sb
        .from('bdl_players')
        .select('bdl_id, full_name')
        .eq('stat_player_id', statPlayerId)
        .maybeSingle()
      if (xErr) throw xErr
      if (!batterXref?.bdl_id) {
        res.json({ data: null })
        return
      }

      const { data: rows, error } = await sb
        .from('bdl_matchups')
        .select(`
          bdl_player_id,
          opponent_bdl_player_id,
          at_bats,
          hits,
          home_runs,
          strikeouts,
          avg,
          obp,
          slg,
          ops
        `)
        .eq('bdl_player_id', batterXref.bdl_id)
      if (error) throw error

      const oppIds = Array.from(
        new Set(
          (rows ?? [])
            .map((r: any) => Number(r.opponent_bdl_player_id ?? 0))
            .filter((n: number) => n > 0),
        ),
      )
      const { data: oppPlayers } = oppIds.length
        ? await sb
            .from('bdl_players')
            .select('bdl_id,full_name,team_abbrev')
            .in('bdl_id', oppIds)
        : ({ data: [] } as any)
      const oppMap = new Map<number, { full_name: string | null; team_abbrev: string | null }>(
        (oppPlayers ?? []).map((p: any) => [
          Number(p.bdl_id),
          {
            full_name: p.full_name ?? null,
            team_abbrev: p.team_abbrev ?? null,
          },
        ]),
      )

      const candidates = (rows ?? [])
        .map((r: any) => {
          const opp = oppMap.get(Number(r.opponent_bdl_player_id ?? 0))
          return {
            pitcher_bdl_id: Number(r.opponent_bdl_player_id ?? 0) || null,
            pitcher_name: opp?.full_name ?? null,
            pitcher_team: canonTeam(String(opp?.team_abbrev ?? '')),
            at_bats: Number(r.at_bats ?? 0),
            hits: Number(r.hits ?? 0),
            home_runs: Number(r.home_runs ?? 0),
            strikeouts: Number(r.strikeouts ?? 0),
            avg: r.avg != null ? Number(r.avg) : null,
            obp: r.obp != null ? Number(r.obp) : null,
            slg: r.slg != null ? Number(r.slg) : null,
            ops: r.ops != null ? Number(r.ops) : null,
          }
        })
        .filter((r) => r.pitcher_team === opponentTeam)
        .sort((a, b) => b.at_bats - a.at_bats)

      const byName = pitcherNameQ
        ? candidates.find((c) => {
            const nm = String(c.pitcher_name ?? '').toLowerCase()
            return nm === pitcherNameQ || nm.includes(pitcherNameQ) || pitcherNameQ.includes(nm)
          }) ?? null
        : null
      const best = byName ?? candidates[0] ?? null
      if (!best) {
        res.json({ data: null })
        return
      }

      const [pitcherStatsRes, batterStatsRes] = await Promise.all([
        best.pitcher_bdl_id
          ? sb
              .from('bdl_season_stats')
              .select('pitching_era,pitching_k,pitching_whip')
              .eq('bdl_player_id', best.pitcher_bdl_id)
              .eq('season', 2026)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null as any }),
        sb
          .from('player_stats_daily')
          .select('home_runs,hits,at_bats')
          .eq('player_id', statPlayerId)
          .eq('date', new Date().toISOString().slice(0, 10))
          .maybeSingle(),
      ])

      res.json({
        data: {
          batter_name: batterXref.full_name,
          batter_stat_player_id: statPlayerId,
          opponent_team: opponentTeam,
          pitcher_name: best.pitcher_name,
          sample_ab: best.at_bats,
          h: best.hits,
          hr: best.home_runs,
          k: best.strikeouts,
          avg: best.avg,
          obp: best.obp,
          slg: best.slg,
          ops: best.ops,
          pitcher_era: pitcherStatsRes.data?.pitching_era ?? null,
          pitcher_k: pitcherStatsRes.data?.pitching_k ?? null,
          pitcher_whip: pitcherStatsRes.data?.pitching_whip ?? null,
          batter_hr: batterStatsRes.data?.home_runs ?? null,
          batter_hits: batterStatsRes.data?.hits ?? null,
          batter_ab: batterStatsRes.data?.at_bats ?? null,
          batter_avg:
            batterStatsRes.data?.hits != null && batterStatsRes.data?.at_bats
              ? Number(batterStatsRes.data.hits) / Number(batterStatsRes.data.at_bats)
              : null,
        },
      })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.get('/bdl/matchup', async (req, res) => {
    try {
      const batterId = Number(req.query.batter_id ?? 0)
      const pitcherId = Number(req.query.pitcher_id ?? 0)
      if (!batterId || !pitcherId) {
        res.status(400).json({ error: 'batter_id and pitcher_id required (BDL IDs)' })
        return
      }
      const sb = getServiceClient()
      const { data, error } = await sb
        .from('bdl_matchups')
        .select('*')
        .eq('bdl_player_id', batterId)
        .eq('opponent_bdl_player_id', pitcherId)
        .maybeSingle()
      if (error) throw error
      res.json({ data })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  /* ── Cross-reference lookup ──────────────────────────────────── */

  app.get('/bdl/player-xref', async (req, res) => {
    try {
      const sb = getServiceClient()
      const statId = String(req.query.stat_player_id ?? '')
      const bdlId = Number(req.query.bdl_id ?? 0)
      const search = String(req.query.search ?? '')

      let query = sb.from('bdl_players').select('*')
      if (statId) query = query.eq('stat_player_id', statId)
      else if (bdlId) query = query.eq('bdl_id', bdlId)
      else if (search) query = query.ilike('full_name', `%${search}%`)
      else {
        res.status(400).json({ error: 'stat_player_id, bdl_id, or search required' })
        return
      }

      const { data, error } = await query.limit(25)
      if (error) throw error
      res.json({ data })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  /* ── HR events for today ─────────────────────────────────────── */

  app.get('/bdl/hr-events', async (req, res) => {
    try {
      const date = String(req.query.date ?? '')
      const sb = getServiceClient()

      let query = sb
        .from('bdl_hr_events')
        .select('*, bdl_players:bdl_batter_id(full_name, team_abbrev, stat_player_id)')
        .order('detected_at', { ascending: false })
        .limit(100)

      if (date) {
        query = query.gte('detected_at', `${date}T00:00:00`)
          .lte('detected_at', `${date}T23:59:59`)
      }

      const { data, error } = await query
      if (error) throw error
      res.json({ data })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })
}
