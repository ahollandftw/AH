import type { Express } from 'express'
import {
  runDailySync,
  syncActivePlayers,
  syncGames,
  syncSeasonStats,
  syncMatchup,
  syncMatchupsForTodayGames,
  syncPlayerProps,
} from '../bdl/sync.js'
import { startLiveMonitor, stopLiveMonitor } from '../bdl/liveMonitor.js'
import { calculateEdge, calculateEdgesForDate } from '../bdl/edge.js'
import { getServiceClient } from '../supabase.js'
import { bdlFetch, bdlFetchAll, type BdlPlay, type BdlPlateAppearance } from '../bdl/client.js'
import { buildHrEventEnrichment } from '../bdl/hrEventEnrichment.js'
import { getBestLineupForGame, getResolvedGamesForDate } from '../bdl/lineups.js'

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
  const shiftIsoDate = (dateIso: string, days: number) => {
    const d = new Date(`${dateIso}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() + days)
    return d.toISOString().slice(0, 10)
  }
  const toNum = (v: unknown): number | null => {
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const weightedAvg = (rows: any[], valueKey: string, weightKey = 'pitch_usage'): number | null => {
    let weightedSum = 0
    let weightSum = 0
    const vals: number[] = []
    for (const row of rows) {
      const value = toNum(row?.[valueKey])
      if (value == null) continue
      vals.push(value)
      const weight = toNum(row?.[weightKey])
      if (weight != null && weight > 0) {
        weightedSum += value * weight
        weightSum += weight
      }
    }
    if (weightSum > 0) return weightedSum / weightSum
    if (!vals.length) return null
    return vals.reduce((a, b) => a + b, 0) / vals.length
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

  /**
   * Inspect season stats: `source=bdl` hits BallDontLie (same key as sync);
   * default `source=db` reads `bdl_season_stats` after POST /bdl/sync/season-stats.
   */
  app.get('/bdl/season-stats', async (req, res) => {
    try {
      const season = Number(req.query.season) || 2026
      const source = String(req.query.source ?? 'db').toLowerCase()
      if (source === 'bdl') {
        const perPage = Math.min(100, Math.max(1, Number(req.query.per_page) || 25))
        const body = await bdlFetch<{ data: unknown[]; meta?: { next_cursor?: number | null } }>(
          '/mlb/v1/season_stats',
          {
            season,
            season_type: 'regular',
            per_page: perPage,
          },
        )
        res.json({
          ok: true,
          source: 'bdl',
          endpoint: 'https://api.balldontlie.io/mlb/v1/season_stats',
          season,
          data: body.data,
          meta: body.meta,
        })
        return
      }
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50))
      const sb = getServiceClient()
      const { data, error, count } = await sb
        .from('bdl_season_stats')
        .select('*', { count: 'exact' })
        .eq('season', season)
        .limit(limit)
      if (error) throw error
      res.json({
        ok: true,
        source: 'db',
        table: 'bdl_season_stats',
        season,
        total_rows: count,
        returned: (data ?? []).length,
        rows: data ?? [],
      })
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

  app.post('/bdl/sync/matchups-today', async (_req, res) => {
    try {
      const result = await syncMatchupsForTodayGames()
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.post('/bdl/sync/projections', async (req, res) => {
    try {
      const { runAndSaveProjections } = await import('../hrEngine.js')
      const date = typeof req.body?.date === 'string' ? req.body.date : undefined
      const result = await runAndSaveProjections(date)
      res.json({ ok: true, ...result })
    } catch (e) {
      console.error('[bdl/sync/projections] failed:', e)
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  app.post('/bdl/sync/projections/upcoming', async (req, res) => {
    try {
      const { runUpcomingLineupRefresh } = await import('../hrEngine.js')
      const windowMinutes = Number(req.body?.window_minutes ?? 60) || 60
      const result = await runUpcomingLineupRefresh(windowMinutes)
      res.json({ ok: true, ...result })
    } catch (e) {
      console.error('[bdl/sync/projections/upcoming] failed:', e)
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
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
      const season = Number(req.query.season ?? 2026) || 2026
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
      let best = byName ?? candidates[0] ?? null
      if (!best) {
        const { data: oppTeamPlayer } = await sb
          .from('bdl_players')
          .select('team_id')
          .eq('team_abbrev', opponentTeam === 'TBR' ? 'TB' : opponentTeam === 'WSN' ? 'WSH' : opponentTeam)
          .not('team_id', 'is', null)
          .limit(1)
          .maybeSingle()
        const oppTeamId = Number((oppTeamPlayer as any)?.team_id ?? 0)
        if (oppTeamId && batterXref.bdl_id) {
          await syncMatchup(Number(batterXref.bdl_id), oppTeamId)
          const { data: retryRows } = await sb
            .from('bdl_matchups')
            .select('opponent_bdl_player_id,at_bats,hits,home_runs,strikeouts,avg,obp,slg,ops')
            .eq('bdl_player_id', batterXref.bdl_id)
          const retryOppIds = Array.from(new Set((retryRows ?? []).map((r: any) => Number(r.opponent_bdl_player_id ?? 0)).filter((n: number) => n > 0)))
          const { data: retryOppPlayers } = retryOppIds.length
            ? await sb.from('bdl_players').select('bdl_id,full_name,team_abbrev').in('bdl_id', retryOppIds)
            : ({ data: [] } as any)
          const retryMap = new Map<number, { full_name: string | null; team_abbrev: string | null }>(
            (retryOppPlayers ?? []).map((p: any) => [Number(p.bdl_id), { full_name: p.full_name ?? null, team_abbrev: p.team_abbrev ?? null }]),
          )
          best =
            (retryRows ?? [])
              .map((r: any) => {
                const opp = retryMap.get(Number(r.opponent_bdl_player_id ?? 0))
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
              .sort((a, b) => b.at_bats - a.at_bats)[0] ?? null
        }
      }
      const [pitcherStatsRes, batterStatsRes] = await Promise.all([
        best?.pitcher_bdl_id
          ? sb
              .from('bdl_season_stats')
              .select('pitching_era,pitching_k,pitching_whip,pitching_hr,pitching_bb,pitching_ip,pitching_k_per_9')
              .eq('bdl_player_id', best.pitcher_bdl_id)
              .eq('season', season)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null as any }),
        Promise.all([
          sb
            .from('stats_homeruns')
            .select('hr_total,year')
            .eq('role', 'batting')
            .eq('type', 'adj_xhr')
            .eq('player_id', statPlayerId)
            .lte('year', season)
            .order('year', { ascending: false })
            .limit(1)
            .maybeSingle(),
          sb
            .from('stats_exit_velocity')
            .select('avg_hit_speed,ev95percent,brl_percent,fbld,attempts,season')
            .eq('role', 'batting')
            .eq('player_id', statPlayerId)
            .lte('season', season)
            .order('season', { ascending: false })
            .limit(1)
            .maybeSingle(),
          sb
            .from('bdl_season_stats')
            .select('batting_ab,batting_bb,batting_so,batting_avg,batting_slg,batting_hr,team_name')
            .eq('bdl_player_id', batterXref.bdl_id)
            .eq('season', season)
            .maybeSingle(),
        ]),
      ])
      let batterHr = (batterStatsRes as any)?.[0]?.data?.hr_total ?? null
      let batterEv = (batterStatsRes as any)?.[1]?.data ?? null
      let batterSeason = (batterStatsRes as any)?.[2]?.data ?? null
      const batterEvSeason = Number(batterEv?.season ?? 0) || null
      const batterHrSeason = Number((batterStatsRes as any)?.[0]?.data?.year ?? 0) || null
      let usedSeason = batterEvSeason ?? batterHrSeason ?? season

      // Pitch-type matchup: pitcher's top pitches by usage + batter ISO vs those pitch types.
      let pitchTypeMatchup: any[] = []
      let batterArsenalRows: any[] = []
      let pitcherArsenalRows: any[] = []
      try {
        if (best?.pitcher_bdl_id) {
          // Map pitcher BDL id -> stat_player_id (so we can query Statcast pitch arsenal)
          const { data: pitX } = await sb
            .from('bdl_players')
            .select('stat_player_id')
            .eq('bdl_id', best.pitcher_bdl_id)
            .maybeSingle()
          const pitcherStatId = (pitX as any)?.stat_player_id ?? null

          const [pitcherArsRes, batterArsRes] = await Promise.all([
            pitcherStatId
              ? sb
                  .from('stats_pitch_arsenal')
                  .select('pitch_type,pitch_name,pitch_usage,slg,ba,woba,est_slg,est_woba,hard_hit_percent,season')
                  .eq('role', 'pitching')
                  .eq('player_id', pitcherStatId)
                  .lte('season', season)
                  .order('season', { ascending: false })
                  .order('pitch_usage', { ascending: false })
                  .limit(40)
              : Promise.resolve({ data: [] as any[] }),
            sb
              .from('stats_pitch_arsenal')
              .select('pitch_type,pitch_name,slg,ba,woba,est_slg,est_woba,k_percent,hard_hit_percent,season')
              .eq('role', 'batting')
              .eq('player_id', statPlayerId)
              .lte('season', season)
              .order('season', { ascending: false })
              .limit(200),
          ])

          const latestPitcherSeason = Number((pitcherArsRes.data?.[0] as any)?.season ?? 0) || null
          const latestBatterSeason = Number((batterArsRes.data?.[0] as any)?.season ?? 0) || null
          if (latestPitcherSeason || latestBatterSeason) {
            usedSeason = Math.max(latestPitcherSeason ?? 0, latestBatterSeason ?? 0, usedSeason ?? 0) || usedSeason
          }
          pitcherArsenalRows = (pitcherArsRes.data ?? []).filter((r: any) => Number(r.season ?? 0) === (latestPitcherSeason ?? usedSeason))
          batterArsenalRows = (batterArsRes.data ?? []).filter((r: any) => Number(r.season ?? 0) === (latestBatterSeason ?? usedSeason))

          const topPitcherRows = pitcherArsenalRows
            .slice()
            .sort((a: any, b: any) => Number(b?.pitch_usage ?? 0) - Number(a?.pitch_usage ?? 0))
            .slice(0, 5)

          const batterByType = new Map<string, any>()
          for (const r of batterArsenalRows) {
            const key = String(r.pitch_type ?? r.pitch_name ?? '').toUpperCase()
            if (!key) continue
            if (!batterByType.has(key)) batterByType.set(key, r)
          }

          pitchTypeMatchup = topPitcherRows.map((p: any) => {
            const key = String(p.pitch_type ?? p.pitch_name ?? '').toUpperCase()
            const b = batterByType.get(key) ?? null
            const batterIso =
              b?.slg != null && b?.ba != null ? Number(b.slg) - Number(b.ba) : null
            const pitcherSlgAllowed = p?.slg != null ? Number(p.slg) : null
            return {
              pitch_type: p.pitch_type ?? null,
              pitch_name: p.pitch_name ?? null,
              usage: p.pitch_usage != null ? Number(p.pitch_usage) : null,
              batter_iso: batterIso,
              batter_slg: b?.slg != null ? Number(b.slg) : null,
              batter_ba: b?.ba != null ? Number(b.ba) : null,
              batter_est_slg: b?.est_slg != null ? Number(b.est_slg) : null,
              batter_est_woba: b?.est_woba != null ? Number(b.est_woba) : null,
              pitcher_slg_allowed: pitcherSlgAllowed,
              pitcher_ba_allowed: p?.ba != null ? Number(p.ba) : null,
              pitcher_est_slg_allowed: p?.est_slg != null ? Number(p.est_slg) : null,
              pitcher_est_woba_allowed: p?.est_woba != null ? Number(p.est_woba) : null,
            }
          })
        }
      } catch {
        pitchTypeMatchup = []
      }

      // Pitcher Statcast mirrors (role=pitching) — same categories as batter where the schema has them.
      let pitcherEv: Record<string, unknown> | null = null
      let pitcherHrM: Record<string, unknown> | null = null
      let pitcherEvSeason: number | null = null
      let pitcherHrSeason: number | null = null
      try {
        if (best?.pitcher_bdl_id) {
          const { data: pitX } = await sb
            .from('bdl_players')
            .select('stat_player_id')
            .eq('bdl_id', best.pitcher_bdl_id)
            .maybeSingle()
          const pitcherStatId = (pitX as { stat_player_id?: string | null })?.stat_player_id ?? null
          if (pitcherStatId) {
            const [evRes, hrRes] = await Promise.all([
              sb
                .from('stats_exit_velocity')
                .select('avg_hit_speed,ev95percent,brl_percent,fbld,season')
                .eq('role', 'pitching')
                .eq('player_id', pitcherStatId)
                .lte('season', season)
                .order('season', { ascending: false })
                .limit(1)
                .maybeSingle(),
              sb
                .from('stats_homeruns')
                .select('hr_total,xhr,year')
                .eq('role', 'pitching')
                .eq('type', 'adj_xhr')
                .eq('player_id', pitcherStatId)
                .lte('year', season)
                .order('year', { ascending: false })
                .limit(1)
                .maybeSingle(),
            ])
            pitcherEv = (evRes.data as Record<string, unknown>) ?? null
            pitcherHrM = (hrRes.data as Record<string, unknown>) ?? null
            pitcherEvSeason = Number((evRes.data as any)?.season ?? 0) || null
            pitcherHrSeason = Number((hrRes.data as any)?.year ?? 0) || null
          }
        }
      } catch {
        pitcherEv = null
        pitcherHrM = null
      }

      // Derived “model” stats we can compute today
      const batterIso =
        batterSeason?.batting_slg != null && batterSeason?.batting_avg != null
          ? Number(batterSeason.batting_slg) - Number(batterSeason.batting_avg)
          : null
      const batterBbPct =
        batterSeason?.batting_bb != null && batterSeason?.batting_ab != null
          ? Number(batterSeason.batting_bb) /
            Math.max(1, Number(batterSeason.batting_ab) + Number(batterSeason.batting_bb))
          : null
      const batterKPct =
        batterSeason?.batting_so != null && batterSeason?.batting_ab != null
          ? Number(batterSeason.batting_so) /
            Math.max(1, Number(batterSeason.batting_ab) + Number(batterSeason.batting_bb ?? 0))
          : null
      const batterHardHit =
        weightedAvg(batterArsenalRows, 'hard_hit_percent') ??
        null
      const pitcherHardHitAllowed =
        weightedAvg(pitcherArsenalRows, 'hard_hit_percent') ??
        null
      const batterIsoFromArsenal = (() => {
        const slg = weightedAvg(batterArsenalRows, 'slg')
        const ba = weightedAvg(batterArsenalRows, 'ba')
        return slg != null && ba != null ? slg - ba : null
      })()
      const pitcherIsoAllowed = (() => {
        const slg = weightedAvg(pitcherArsenalRows, 'slg')
        const ba = weightedAvg(pitcherArsenalRows, 'ba')
        return slg != null && ba != null ? slg - ba : null
      })()
      const pitcherBbPer9 =
        pitcherStatsRes.data?.pitching_bb != null && pitcherStatsRes.data?.pitching_ip != null
          ? (Number(pitcherStatsRes.data.pitching_bb) / Math.max(0.1, Number(pitcherStatsRes.data.pitching_ip))) * 9
          : null
      const batterDataSeason =
        batterEvSeason ?? batterHrSeason ?? usedSeason ?? season
      const pitcherDataSeason =
        pitcherEvSeason ?? pitcherHrSeason ?? usedSeason ?? season

      res.json({
        data: {
          batter_name: batterXref.full_name,
          batter_stat_player_id: statPlayerId,
          opponent_team: opponentTeam,
          pitcher_name: best?.pitcher_name ?? null,
          pitch_type_matchup: pitchTypeMatchup,
          sample_ab: best?.at_bats ?? null,
          h: best?.hits ?? null,
          hr: best?.home_runs ?? null,
          k: best?.strikeouts ?? null,
          avg: best?.avg ?? null,
          obp: best?.obp ?? null,
          slg: best?.slg ?? null,
          ops: best?.ops ?? null,
          pitcher_era: pitcherStatsRes.data?.pitching_era ?? null,
          pitcher_k: pitcherStatsRes.data?.pitching_k ?? null,
          pitcher_k_per_9: pitcherStatsRes.data?.pitching_k_per_9 ?? null,
          pitcher_bb: pitcherStatsRes.data?.pitching_bb ?? null,
          pitcher_ip: pitcherStatsRes.data?.pitching_ip ?? null,
          pitcher_whip: pitcherStatsRes.data?.pitching_whip ?? null,
          pitcher_hr_allowed: pitcherStatsRes.data?.pitching_hr ?? null,
          batter_hr: batterHr,
          batter_avg_hit_speed: batterEv?.avg_hit_speed ?? null,
          batter_ev95: batterEv?.ev95percent ?? null,
          batter_barrel: batterEv?.brl_percent ?? null,
          batter_hard_hit: batterHardHit,
          batter_fbld: batterEv?.fbld ?? null,
          batter_attempts: batterEv?.attempts ?? null,
          batter_iso: batterIso ?? batterIsoFromArsenal,
          batter_bb_pct: batterBbPct,
          batter_k_pct: batterKPct,
          batter_season_hr: batterSeason?.batting_hr ?? null,
          pitcher_avg_hit_speed_allowed: pitcherEv?.avg_hit_speed ?? null,
          pitcher_ev95_allowed: pitcherEv?.ev95percent ?? null,
          pitcher_barrel_allowed: pitcherEv?.brl_percent ?? null,
          pitcher_hard_hit_allowed: pitcherHardHitAllowed,
          pitcher_fbld_allowed: pitcherEv?.fbld ?? null,
          pitcher_iso_allowed: pitcherIsoAllowed,
          pitcher_bb_per_9: pitcherBbPer9,
          pitcher_hr_statcast: pitcherHrM?.hr_total ?? null,
          pitcher_xhr_statcast: pitcherHrM?.xhr ?? null,
          batter_data_season: batterDataSeason,
          pitcher_data_season: pitcherDataSeason,
          /** Structured to match the HR matchup checklist (null = not in our CSV schema). */
          matchup_framework: {
            power: {
              batter_iso: batterIso ?? batterIsoFromArsenal,
              batter_hr_fb: null,
              pitcher_iso_allowed: pitcherIsoAllowed,
              pitcher_hr_fb_allowed: null,
            },
            contact_quality: {
              batter_barrel_pct: batterEv?.brl_percent ?? null,
              batter_hard_hit_pct: batterHardHit,
              batter_avg_ev: batterEv?.avg_hit_speed ?? null,
              pitcher_barrel_pct_allowed: pitcherEv?.brl_percent ?? null,
              pitcher_hard_hit_pct_allowed: pitcherHardHitAllowed,
              pitcher_avg_ev_allowed: pitcherEv?.avg_hit_speed ?? null,
            },
            launch_profile: {
              batter_fb_pct: batterEv?.fbld ?? null,
              batter_pull_pct: null,
              pitcher_fb_pct_allowed: pitcherEv?.fbld ?? null,
              pitcher_pull_contact_pct: null,
            },
            plate_skills: {
              batter_k_pct: batterKPct,
              batter_bb_pct: batterBbPct,
              pitcher_k_pct_implied: pitcherStatsRes.data?.pitching_k_per_9 ?? null,
              pitcher_bb_per_9_implied:
                pitcherStatsRes.data?.pitching_bb != null &&
                pitcherStatsRes.data?.pitching_ip != null
                  ? (Number(pitcherStatsRes.data.pitching_bb) /
                      Math.max(0.1, Number(pitcherStatsRes.data.pitching_ip))) *
                    9
                  : null,
            },
            expected_metrics: {
              batter_xslg_proxy: null,
              batter_xwoba_proxy: null,
              pitcher_xslg_allowed_proxy: null,
              pitcher_xwoba_allowed_proxy: null,
            },
            pitch_type_edge: pitchTypeMatchup,
            splits: {
              vs_hand: null,
              home_away: null,
              last_15: null,
            },
          },
          data_gaps: [
            'HR/FB%, pull%, and granular xSLG/xwOBA are not columns in the imported Statcast CSVs; use barrel %, FB%, and pitch-type est_slg / est_woba rows where present.',
            'Handedness, home/away, and rolling 15-day form need a separate feed or Statcast query pipeline.',
          ],
          season: usedSeason,
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
      console.error('[bdl/hr-events] failed:', e)
      res
        .status(500)
        .json({ error: e instanceof Error ? (e.stack ?? e.message) : String(e) })
    }
  })

  // Backfill/refresh HR events for a date by scanning all plays (not just live-monitor deltas).
  app.post('/bdl/hr-events/refresh-today', async (req, res) => {
    try {
      const date = String(req.body?.date ?? req.query.date ?? '').trim()
      const sb = getServiceClient()

      // Ensure we have the slate in DB (also keeps bdl_games current)
      await syncGames(date || undefined)

      // Pull game IDs for the date from Supabase
      let q = sb.from('bdl_games').select('bdl_game_id,date')
      if (date) q = q.eq('date', date)
      else q = q.order('date', { ascending: false }).limit(20)
      const { data: games, error: gErr } = await q
      if (gErr) throw gErr

      const HR_PATTERNS = [/homer/i, /home run/i, /grand slam/i, /homers/i]
      const isHomeRunPlay = (p: BdlPlay) =>
        Boolean(p.scoring_play && p.text && HR_PATTERNS.some((re) => re.test(p.text!)))

      let inserted = 0
      let scannedGames = 0

      for (const g of (games ?? []) as any[]) {
        const gameId = Number(g.bdl_game_id)
        if (!gameId) continue
        scannedGames++

        const plays = await bdlFetchAll<BdlPlay>('/mlb/v1/plays', { game_id: gameId })
        const hrPlays = plays.filter(isHomeRunPlay)
        if (!hrPlays.length) continue

        // plate appearances (for hit_distance, pitch type fallback)
        let plateApps: BdlPlateAppearance[] | null = null
        try {
          const paRes = await bdlFetch<{ data: BdlPlateAppearance[] }>('/mlb/v1/plate_appearances', { game_id: gameId })
          plateApps = paRes.data ?? []
        } catch {
          plateApps = null
        }

        // Cross-ref batter & pitcher IDs -> names/stat ids
        const batterIds = [...new Set(hrPlays.map((p) => p.batter_id).filter(Boolean))] as number[]
        const pitcherIds = [...new Set(hrPlays.map((p) => p.pitcher_id).filter(Boolean))] as number[]

        const [{ data: batX }, { data: pitX }] = await Promise.all([
          batterIds.length
            ? sb.from('bdl_players').select('bdl_id,stat_player_id,full_name').in('bdl_id', batterIds)
            : Promise.resolve({ data: [] as any[] }),
          pitcherIds.length
            ? sb.from('bdl_players').select('bdl_id,full_name').in('bdl_id', pitcherIds)
            : Promise.resolve({ data: [] as any[] }),
        ])

        const batterMap = new Map((batX ?? []).map((r: any) => [Number(r.bdl_id), r]))
        const pitcherMap = new Map((pitX ?? []).map((r: any) => [Number(r.bdl_id), String(r.full_name)]))

        for (const play of hrPlays) {
          if (!play.batter_id) continue
          const batter = batterMap.get(play.batter_id)
          const statId = batter?.stat_player_id ?? null

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

          const enrich = await buildHrEventEnrichment(sb, gameId, play.batter_id, play.pitcher_id ?? null, statId)

          try {
            await sb.from('bdl_hr_events').upsert(
              {
                bdl_game_id: gameId,
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
          } catch {
            await sb.from('bdl_hr_events').upsert(
              {
                bdl_game_id: gameId,
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

          inserted++
        }
      }

      res.json({ ok: true, date: date || null, scannedGames, inserted })
    } catch (e) {
      console.error('[bdl/hr-events/refresh-today] failed:', e)
      res
        .status(500)
        .json({ error: e instanceof Error ? (e.stack ?? e.message) : String(e) })
    }
  })

  /** Fill game_date / venue / H–A flags for rows inserted before enrichment existed. */
  app.post('/bdl/hr-events/backfill-enrichment', async (_req, res) => {
    try {
      const sb = getServiceClient()
      const { data: events, error } = await sb
        .from('bdl_hr_events')
        .select('id,bdl_game_id,bdl_batter_id,bdl_pitcher_id,stat_player_id')
        .limit(5000)
      if (error) throw error
      let updated = 0
      for (const ev of events ?? []) {
        const enrich = await buildHrEventEnrichment(
          sb,
          Number(ev.bdl_game_id),
          Number(ev.bdl_batter_id),
          ev.bdl_pitcher_id != null ? Number(ev.bdl_pitcher_id) : null,
          ev.stat_player_id ?? null,
        )
        await sb.from('bdl_hr_events').update(enrich).eq('id', ev.id)
        updated++
      }
      res.json({ ok: true, updated })
    } catch (e) {
      console.error('[bdl/hr-events/backfill-enrichment] failed:', e)
      res
        .status(500)
        .json({ error: e instanceof Error ? (e.stack ?? e.message) : String(e) })
    }
  })

  /* ── Probable pitchers for a date ───────────────────────────────── */
  app.get('/bdl/probable-pitchers', async (req, res) => {
    try {
      const date = String(req.query.date ?? '').trim()
      if (!date) { res.status(400).json({ error: 'date required' }); return }

      type BdlProbablePitcherEntry = {
        game_id: number
        home_probable_pitcher?: { id: number; full_name: string } | null
        away_probable_pitcher?: { id: number; full_name: string } | null
      }
      type BdlProbablePitchersResponse = { data?: BdlProbablePitcherEntry[] }

      const sb = getServiceClient()
      const resolvedGames = await getResolvedGamesForDate(sb, date)
      const validGameIds = new Set(resolvedGames.map((g) => Number(g.bdl_game_id)))
      if (!validGameIds.size) {
        res.json({ data: {} })
        return
      }

      let entries: BdlProbablePitcherEntry[] = []
      for (const d of [date, shiftIsoDate(date, -1), shiftIsoDate(date, 1)]) {
        try {
          const raw = await bdlFetch<BdlProbablePitchersResponse>('/mlb/v1/probable_pitchers', { 'dates[]': d })
          entries.push(...(raw?.data ?? []))
        } catch {
          // ignore split-date misses from BDL and keep scanning adjacent days
        }
      }

      const out: Record<number, { home: string | null; away: string | null }> = {}
      for (const e of entries) {
        if (!validGameIds.has(Number(e.game_id))) continue
        out[e.game_id] = {
          home: e.home_probable_pitcher?.full_name ?? null,
          away: e.away_probable_pitcher?.full_name ?? null,
        }
      }
      res.json({ data: out })
    } catch (e) {
      console.error('[bdl/probable-pitchers] failed:', e)
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  /* ── Lineup: fetch from BDL and cross-ref to stat_player_id ─────── */
  app.get('/bdl/lineup', async (req, res) => {
    try {
      const bdlGameId = Number(req.query.game_id ?? 0) || null
      const date = String(req.query.date ?? '').trim()
      const homeTeam = String(req.query.home_team ?? '').trim()
      const awayTeam = String(req.query.away_team ?? '').trim()

      if (!bdlGameId && (!date || !homeTeam || !awayTeam)) {
        res.status(400).json({ error: 'game_id or date+home_team+away_team required' })
        return
      }
      const sb = getServiceClient()
      let resolvedHome = homeTeam
      let resolvedAway = awayTeam

      let resolvedDate = date
      if ((!resolvedHome || !resolvedAway || !resolvedDate) && bdlGameId) {
        const { data: game } = await sb
          .from('bdl_games')
          .select('home_team_abbrev,away_team_abbrev,date')
          .eq('bdl_game_id', bdlGameId)
          .maybeSingle()
        resolvedHome = game?.home_team_abbrev ?? resolvedHome
        resolvedAway = game?.away_team_abbrev ?? resolvedAway
        resolvedDate = game?.date ?? resolvedDate
      }

      const best = await getBestLineupForGame(sb, {
        dateIso: resolvedDate,
        gameId: bdlGameId,
        homeTeam: resolvedHome,
        awayTeam: resolvedAway,
      })

      if (!best.home.length && !best.away.length) {
        res.json({ data: null, reason: 'No official or recent lineup found' })
        return
      }

      res.json({ data: best })
    } catch (e) {
      console.error('[bdl/lineup] failed:', e)
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  })
}
