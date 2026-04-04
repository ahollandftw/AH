import type { Express, Request, Response } from 'express'
import { mergedHrProbabilityMapForDate } from '../matchupProjectionMerge.js'
import { getServiceClient } from '../supabase.js'
import type { LeaderboardEntry, LeaderboardResponse } from '../types.js'

function utcToETDateIso(utcStr: string | null | undefined): string | null {
  if (!utcStr) return null
  try {
    const d = new Date(new Date(utcStr).toLocaleString('en-US', { timeZone: 'America/New_York' }))
    if (Number.isNaN(d.getTime())) return null
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${dd}`
  } catch {
    return null
  }
}

function parseIncludeLow(req: Request): boolean {
  return req.query.include_low_sample === 'true'
}

/** YYYY-MM for the current month in America/New_York (MLB calendar context). */
function defaultCalendarMonthIso(): string {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** ~68 team AB per 9-inning game (34 per side). Used when box AB totals are unavailable. */
const EST_AB_PER_GAME = 68

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

  // ── HR Tracking: one row per stored HR (`bdl_hr_events`) ───────────
  app.get('/leaderboard/homers', async (req, res: Response) => {
    try {
      const limit = Math.min(5000, Math.max(1, Number(req.query.limit ?? '500') || 500))
      const season =
        Number(req.query.season ?? new Date().getUTCFullYear()) || new Date().getUTCFullYear()
      const sortBy = String(req.query.sort ?? 'date').toLowerCase()
      const sortDir = String(req.query.dir ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc'
      const qStadium = String(req.query.stadium ?? '').trim().toLowerCase()
      const qTeam = String(req.query.team ?? '').trim().toLowerCase()
      const qPitcher = String(req.query.pitcher ?? '').trim().toLowerCase()
      const qBatter = String(req.query.batter ?? '').trim().toLowerCase()

      const supabase = getServiceClient()

      const { data: seasonGames, error: gErr } = await supabase
        .from('bdl_games')
        .select('bdl_game_id,date,start_time_utc,venue,home_team_abbrev,away_team_abbrev')
        .gte('date', `${season}-01-01`)
        .lte('date', `${season}-12-31`)

      if (gErr) throw gErr

      const gameMeta = new Map<
        number,
        { date: string; start_time_utc: string | null; venue: string | null; home: string; away: string }
      >()
      for (const g of seasonGames ?? []) {
        const id = Number((g as { bdl_game_id: number }).bdl_game_id)
        if (!id) continue
        gameMeta.set(id, {
          date: String((g as { date: string }).date),
          start_time_utc: (g as { start_time_utc: string | null }).start_time_utc ?? null,
          venue: (g as { venue: string | null }).venue ?? null,
          home: String((g as { home_team_abbrev: string }).home_team_abbrev ?? ''),
          away: String((g as { away_team_abbrev: string }).away_team_abbrev ?? ''),
        })
      }

      let query = supabase.from('bdl_hr_events').select('*').order('id', { ascending: false }).limit(8000)

      const gameIds = [...gameMeta.keys()]
      if (gameIds.length) {
        query = supabase
          .from('bdl_hr_events')
          .select('*')
          .in('bdl_game_id', gameIds)
          .order('id', { ascending: false })
          .limit(8000)
      }

      const { data: rawEvents, error: evErr } = await query
      if (evErr) throw evErr

      let events = (rawEvents ?? []) as Record<string, unknown>[]
      if (!gameIds.length) {
        events = events.filter((ev) => {
          const d = String(ev.detected_at ?? '')
          return d.startsWith(String(season))
        })
      }

      const statIds = Array.from(
        new Set(
          events.map((e) => String(e.stat_player_id ?? '')).filter((s) => s.length > 0),
        ),
      )
      const batterIds = Array.from(
        new Set(
          events.map((e) => Number(e.bdl_batter_id ?? 0)).filter((n) => n > 0),
        ),
      )

      const [{ data: playersByStat }, { data: battersByBdl }] = await Promise.all([
        statIds.length
          ? supabase.from('players').select('stat_player_id,name,team').in('stat_player_id', statIds)
          : Promise.resolve({ data: [] as { stat_player_id: string; name: string; team: string | null }[] }),
        batterIds.length
          ? supabase.from('bdl_players').select('bdl_id,full_name,team_abbrev').in('bdl_id', batterIds)
          : Promise.resolve({ data: [] as { bdl_id: number; full_name: string | null }[] }),
      ])

      const playerByStat = new Map(
        (playersByStat ?? []).map((p: { stat_player_id: string; name: string; team: string | null }) => [
          String(p.stat_player_id),
          p,
        ]),
      )
      const nameByBdlBatter = new Map(
        (battersByBdl ?? []).map((p: { bdl_id: number; full_name: string | null }) => [
          Number(p.bdl_id),
          String(p.full_name ?? ''),
        ]),
      )

      type HrRow = {
        id: number
        game_date: string | null
        stadium: string | null
        home_team: string | null
        away_team: string | null
        batter_team: string | null
        batter_name: string | null
        pitcher_name: string | null
        batter_home_away: string | null
        pitcher_home_away: string | null
        pitch_type: string | null
        distance: number | null
        today_probability: number | null
        stat_player_id: string | null
      }

      const rowsUnsorted: HrRow[] = []

      for (const ev of events) {
        const gid = Number(ev.bdl_game_id ?? 0)
        const meta = gameMeta.get(gid)
        const gameDate =
          utcToETDateIso(meta?.start_time_utc) ??
          (ev.game_date as string | null | undefined) ??
          meta?.date ??
          null
        const stadium =
          (ev.venue as string | null | undefined) ?? meta?.venue ?? null
        const sid = ev.stat_player_id != null ? String(ev.stat_player_id) : null
        const pRow = sid ? playerByStat.get(sid) : null
        const batterName =
          (pRow?.name as string | undefined) ??
          nameByBdlBatter.get(Number(ev.bdl_batter_id ?? 0)) ??
          null
        const batterTeam =
          (ev.batter_team_abbrev as string | null | undefined) ??
          (pRow?.team as string | undefined) ??
          null

        rowsUnsorted.push({
          id: Number(ev.id ?? 0),
          game_date: gameDate,
          stadium,
          home_team: meta?.home ?? null,
          away_team: meta?.away ?? null,
          batter_team: batterTeam,
          batter_name: batterName,
          pitcher_name: (ev.pitcher_name as string | null) ?? null,
          batter_home_away: (ev.batter_home_away as string | null) ?? null,
          pitcher_home_away: (ev.pitcher_home_away as string | null) ?? null,
          pitch_type: (ev.pitch_type as string | null) ?? null,
          distance: ev.hit_distance != null ? Number(ev.hit_distance) : null,
          today_probability: null,
          stat_player_id: sid,
        })
      }

      const datesNeeded = Array.from(
        new Set(
          rowsUnsorted
            .map((r) => r.game_date)
            .filter((d): d is string => Boolean(d)),
        ),
      )
      const probByDate = new Map<string, Map<string, number>>()
      for (const d of datesNeeded) {
        const needIds = rowsUnsorted
          .filter((r) => r.game_date === d && r.stat_player_id)
          .map((r) => r.stat_player_id!) as string[]
        const m = await mergedHrProbabilityMapForDate(supabase, d, needIds)
        probByDate.set(d, m)
      }

      for (const r of rowsUnsorted) {
        if (!r.stat_player_id || !r.game_date) continue
        const m = probByDate.get(r.game_date)
        const p = m?.get(r.stat_player_id)
        if (p != null) r.today_probability = p
      }

      let rows = rowsUnsorted.filter((r) => {
        if (qStadium && !(r.stadium ?? '').toLowerCase().includes(qStadium)) return false
        if (qTeam && !(r.batter_team ?? '').toLowerCase().includes(qTeam)) return false
        if (qPitcher && !(r.pitcher_name ?? '').toLowerCase().includes(qPitcher)) return false
        if (qBatter && !(r.batter_name ?? '').toLowerCase().includes(qBatter)) return false
        return true
      })

      const cmp = (a: HrRow, b: HrRow): number => {
        let va: string | number = ''
        let vb: string | number = ''
        switch (sortBy) {
          case 'stadium':
            va = (a.stadium ?? '').toLowerCase()
            vb = (b.stadium ?? '').toLowerCase()
            break
          case 'team':
            va = (a.batter_team ?? '').toLowerCase()
            vb = (b.batter_team ?? '').toLowerCase()
            break
          case 'pitcher':
            va = (a.pitcher_name ?? '').toLowerCase()
            vb = (b.pitcher_name ?? '').toLowerCase()
            break
          case 'batter':
            va = (a.batter_name ?? '').toLowerCase()
            vb = (b.batter_name ?? '').toLowerCase()
            break
          case 'date':
          default:
            va = a.game_date ?? ''
            vb = b.game_date ?? ''
            break
        }
        if (va < vb) return sortDir === 'asc' ? -1 : 1
        if (va > vb) return sortDir === 'asc' ? 1 : -1
        return b.id - a.id
      }
      rows.sort(cmp)

      const monthParam = String(req.query.month ?? '').trim()
      const calendarMonth = /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : defaultCalendarMonthIso()
      const monthPrefix = `${calendarMonth}-`

      const calendar_counts = rowsUnsorted.reduce<Record<string, number>>((acc, row) => {
        if (!row.game_date?.startsWith(monthPrefix)) return acc
        acc[row.game_date] = (acc[row.game_date] ?? 0) + 1
        return acc
      }, {})

      const calendar_games_per_date: Record<string, number> = {}
      const calendar_ab_per_date: Record<string, number> = {}
      const calendar_hr_pct_per_date: Record<string, number | null> = {}
      for (const g of seasonGames ?? []) {
        const d = String((g as { date: string }).date)
        if (!d.startsWith(monthPrefix)) continue
        calendar_games_per_date[d] = (calendar_games_per_date[d] ?? 0) + 1
      }
      for (const d of Object.keys(calendar_counts)) {
        const games = calendar_games_per_date[d] ?? 0
        const ab = games * EST_AB_PER_GAME
        calendar_ab_per_date[d] = ab
        const hr = calendar_counts[d] ?? 0
        if (ab > 0) calendar_hr_pct_per_date[d] = (hr / ab) * 100
        else calendar_hr_pct_per_date[d] = hr > 0 ? null : 0
      }
      for (const d of Object.keys(calendar_games_per_date)) {
        if (calendar_counts[d] != null) continue
        calendar_ab_per_date[d] = (calendar_games_per_date[d] ?? 0) * EST_AB_PER_GAME
        calendar_hr_pct_per_date[d] = 0
      }

      res.json({
        last_updated: new Date().toISOString(),
        season,
        count: rows.length,
        calendar_month: calendarMonth,
        calendar_counts,
        calendar_games_per_date,
        calendar_ab_per_date,
        calendar_hr_pct_per_date,
        calendar_ab_per_game_estimate: EST_AB_PER_GAME,
        persisted:
          'Each HR is stored in Supabase `bdl_hr_events` (enriched from `bdl_games`) for future reference.',
        events: rows.slice(0, limit),
      })
    } catch (e) {
      console.error('[leaderboard/homers] failed:', e)
      res.status(500).json({
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      })
    }
  })
}
