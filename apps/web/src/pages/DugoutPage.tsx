import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  formatProbability,
  getAppDisplayDateIso,
  getGamesForDate,
  getScheduleDates,
  listDailyHrProjections,
  type DailyProjection,
  type ScheduleGame,
} from '@kinetic/shared'
import { useWebAuth } from '../auth/WebAuthProvider.tsx'
import { normalizeTeamCode, paletteForTeam, teamAbbrevContrastStyle } from '../theme/teamPalette'
import { bdlRowMatchesCalendarDay } from '../utils/bdlCalendarDay'
import hrIcon96 from '../../../../data/icons8-home-run-96.png'
import hrIcon64 from '../../../../data/icons8-home-run-64.png'

type WeatherSlateEntry = {
  home_team: string | null
  stadium: string | null
  weather?: {
    current?: {
      temp?: number
      feels_like?: number
      weather?: Array<{ description?: string }>
    }
  }
  error?: string
}

function formatBallparkWx(entry: WeatherSlateEntry | undefined): string | null {
  if (!entry?.weather?.current || entry.error) return null
  const c = entry.weather.current
  const t = c.temp
  const desc = c.weather?.[0]?.description
  if (t == null && !desc) return null
  const parts: string[] = []
  if (t != null) parts.push(`${Math.round(t)}°F`)
  if (desc) parts.push(desc)
  return parts.join(' · ')
}

export default function DugoutPage() {
  const { supabase, hasSubscription, session } = useWebAuth()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<DailyProjection[]>([])
  const [games, setGames] = useState<ScheduleGame[]>([])
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [displayDate, setDisplayDate] = useState(getAppDisplayDateIso())
  const [expandedGameId, setExpandedGameId] = useState<string | null>(null)
  const [pickState, setPickState] = useState<Record<string, boolean | null>>({})
  const [pickBusy, setPickBusy] = useState<string | null>(null)
  const [pickMsg, setPickMsg] = useState('')
  const [matchupLoading, setMatchupLoading] = useState(false)
  const [matchupFor, setMatchupFor] = useState<DailyProjection | null>(null)
  const [matchupData, setMatchupData] = useState<any>(null)
  const [liveGames, setLiveGames] = useState<any[]>([])
  const [selectedYear, setSelectedYear] = useState<number>(2026)
  const [playerInputs, setPlayerInputs] = useState<any>(null)
  const [weatherByHome, setWeatherByHome] = useState<Record<string, WeatherSlateEntry>>({})
  type LineupPlayer = { bdl_player_id: number | null; stat_player_id: string | null; full_name: string | null; position: string | null; batting_order: number | null }
  const [lineupByGame, setLineupByGame] = useState<Record<string, { home: LineupPlayer[]; away: LineupPlayer[] } | null>>({})
  const [lineupLoadingFor, setLineupLoadingFor] = useState<string | null>(null)
  // { [bdlGameId]: { home: pitcherName|null, away: pitcherName|null } }
  const [probablePitchers, setProbablePitchers] = useState<Record<string, { home: string | null; away: string | null }>>({})
  // { [statPlayerId]: americanOdds number }
  const [playerOdds, setPlayerOdds] = useState<Record<string, number | null>>({})
  const [defaultSportsbook, setDefaultSportsbook] = useState<string>('draftkings')
  type CachedLineupTeam = { players: { full_name: string; stat_player_id: string | null; position: string | null; batting_order: number | null }[]; source: 'confirmed' | 'yesterday' | 'none'; team: string }
  const [cachedLineups, setCachedLineups] = useState<Record<string, { home: CachedLineupTeam; away: CachedLineupTeam }>>({})


  useEffect(() => {
    if (!supabase) return
    void getScheduleDates(supabase).then((dates) => {
      if (!dates.length) return
      setAvailableDates(dates)
      setDisplayDate((d) => {
        if (dates.includes(d)) return d
        const today = getAppDisplayDateIso()
        if (dates.includes(today)) return today
        return dates[dates.length - 1] ?? d
      })
    })
  }, [supabase])

  // Load user's preferred sportsbook
  useEffect(() => {
    if (!supabase || !session?.user.id) return
    void supabase
      .from('user_settings')
      .select('default_sportsbook')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.default_sportsbook) setDefaultSportsbook(String(data.default_sportsbook))
      })
  }, [supabase, session?.user.id])

  useEffect(() => {
    if (!supabase) return
    setLoading(true)
    const dayIso = displayDate

    // Load games first (fast, reliable), then projections separately so a
    // projection failure doesn't prevent games from rendering.
    const gamesP = Promise.all([
      getGamesForDate(supabase, dayIso),
      supabase
        .from('bdl_games')
        .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev,status,home_score,away_score,home_hits,away_hits,home_errors,away_errors,home_inning_scores,away_inning_scores,current_period,scoring_summary')
        .eq('date', dayIso),
    ]).then(([sched, live]) => {
      setGames(sched)
      const raw = (live.data ?? []) as any[]
      setLiveGames(raw.filter((lg) => bdlRowMatchesCalendarDay(lg, dayIso)))
    })

    const projP = listDailyHrProjections(supabase, dayIso)
      .then((proj) => setRows(proj))
      .catch((err) => {
        console.error('[DugoutPage] projection load failed:', err)
        setRows([])
      })

    void Promise.all([gamesP, projP]).finally(() => setLoading(false))
  }, [supabase, displayDate])

  // Fetch probable pitchers from BDL for this date
  useEffect(() => {
    const base = import.meta.env.VITE_API_BASE_URL ?? ''
    if (!base) return
    void fetch(`${base}/bdl/probable-pitchers?date=${displayDate}`)
      .then((r) => r.ok ? r.json() : null)
      .then((json: { data?: Record<string, { home: string | null; away: string | null }> } | null) => {
        if (json?.data) setProbablePitchers(json.data)
      })
      .catch(() => {})
  }, [displayDate])

  useEffect(() => {
    if (!supabase) return
    const id = setInterval(() => {
      void supabase
        .from('bdl_games')
        .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev,status,home_score,away_score,home_hits,away_hits,home_errors,away_errors,home_inning_scores,away_inning_scores,current_period,scoring_summary')
        .eq('date', displayDate)
        .then(({ data }) => {
          const raw = (data ?? []) as any[]
          const dayIso = displayDate
          setLiveGames(raw.filter((lg) => bdlRowMatchesCalendarDay(lg, dayIso)))
        })
    }, 60000)
    return () => clearInterval(id)
  }, [displayDate, supabase])

  // Fetch HR odds for top-projected batters from the user's preferred sportsbook
  useEffect(() => {
    if (!supabase || !liveGames.length || !rows.length) { setPlayerOdds({}); return }
    const bdlGameIds = liveGames.map((g: any) => g.bdl_game_id).filter(Boolean) as number[]
    if (!bdlGameIds.length) return

    // Collect all top-projected stat_player_ids visible in the game cards
    const topStatIds = [...new Set(rows.map((r) => r.playerId))]
    if (!topStatIds.length) return

    void (async () => {
      // Cross-ref stat_player_id → bdl_player_id
      const { data: xref } = await supabase
        .from('bdl_players')
        .select('bdl_id,stat_player_id')
        .in('stat_player_id', topStatIds.slice(0, 100))
      const statToBdl = new Map<string, number>(
        (xref ?? []).map((r: any) => [String(r.stat_player_id), Number(r.bdl_id)])
      )
      const bdlPlayerIds = [...statToBdl.values()].filter(Boolean)
      if (!bdlPlayerIds.length) return

      // Fetch HR milestone/over props from the user's sportsbook
      const { data: props } = await supabase
        .from('bdl_player_props')
        .select('bdl_player_id,milestone_odds,over_odds,vendor')
        .in('bdl_game_id', bdlGameIds)
        .in('bdl_player_id', bdlPlayerIds)
        .eq('prop_type', 'home_runs')
        .ilike('vendor', defaultSportsbook)

      if (!props?.length) return
      const bdlToStat = new Map<number, string>()
      for (const [sid, bid] of statToBdl) bdlToStat.set(bid, sid)

      const next: Record<string, number | null> = {}
      for (const p of props as any[]) {
        const sid = bdlToStat.get(Number(p.bdl_player_id))
        if (!sid) continue
        const odds = p.milestone_odds ?? p.over_odds ?? null
        if (odds != null) next[sid] = Number(odds)
      }
      setPlayerOdds(next)
    })()
  }, [supabase, liveGames, rows, defaultSportsbook])

  const topByTeam = useMemo(() => {
    const m = new Map<string, DailyProjection>()
    for (const r of rows) {
      if (!r.team) continue
      const key = normalizeTeamCode(r.team) ?? r.team
      const prev = m.get(key)
      const currP = r.hrProbability ?? -1
      const prevP = prev?.hrProbability ?? -1
      if (!prev || currP > prevP) m.set(key, r)
    }
    return m
  }, [rows])

  const visibleGames = useMemo(() => {
    const pairKey = (a: string, b: string) =>
      [normalizeTeamCode(a) ?? a, normalizeTeamCode(b) ?? b].sort().join('|')
    const liveById = new Map<string, any>()
    const byPair = new Map<string, any>()
    for (const g of liveGames) {
      const id = String(g.bdl_game_id ?? '')
      if (id) liveById.set(id, g)
      byPair.set(pairKey(g.home_team_abbrev, g.away_team_abbrev), g)
    }
    const pickLive = (game: ScheduleGame) =>
      liveById.get(game.gameId) ?? byPair.get(pairKey(game.homeTeam, game.awayTeam)) ?? null
    const sorted = [...games].sort((a, b) => {
      const ga = pickLive(a)
      const gb = pickLive(b)
      const ta = ga?.start_time_utc ? new Date(ga.start_time_utc).getTime() : Number.MAX_SAFE_INTEGER
      const tb = gb?.start_time_utc ? new Date(gb.start_time_utc).getTime() : Number.MAX_SAFE_INTEGER
      return ta - tb
    })
    if (hasSubscription || sorted.length <= 1) return sorted
    const idx =
      displayDate.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % sorted.length
    return [sorted[idx]]
  }, [displayDate, games, hasSubscription, liveGames])

  // Fetch cached lineups (confirmed or yesterday's projected) for all visible games
  useEffect(() => {
    const base = import.meta.env.VITE_API_BASE_URL ?? ''
    if (!base || visibleGames.length === 0) {
      setCachedLineups({})
      return
    }
    const ac = new AbortController()
    void (async () => {
      const next: Record<string, { home: CachedLineupTeam; away: CachedLineupTeam }> = {}
      await Promise.all(
        visibleGames.map(async (g) => {
          const home = normalizeTeamCode(g.homeTeam) ?? g.homeTeam
          const away = normalizeTeamCode(g.awayTeam) ?? g.awayTeam
          try {
            const r = await fetch(
              `${base}/bdl/cached-lineups?date=${displayDate}&home_team=${home}&away_team=${away}`,
              { signal: ac.signal },
            )
            if (!r.ok) return
            const json = await r.json()
            if (json?.data) {
              next[`${away}@${home}`] = json.data
            }
          } catch { /* aborted or network error */ }
        }),
      )
      setCachedLineups(next)
    })()
    return () => ac.abort()
  }, [displayDate, visibleGames])

  useEffect(() => {
    const base = import.meta.env.VITE_API_BASE_URL ?? ''
    if (!base || visibleGames.length === 0) {
      setWeatherByHome({})
      return
    }
    const homes = [
      ...new Set(visibleGames.map((g) => normalizeTeamCode(g.homeTeam) ?? g.homeTeam)),
    ]
    const ac = new AbortController()
    void fetch(`${base}/bdl/weather/slate?homes=${encodeURIComponent(homes.join(','))}`, {
      signal: ac.signal,
    })
      .then((r) => {
        if (!r.ok) return null
        return r.json() as Promise<{ entries?: WeatherSlateEntry[] }>
      })
      .then((data) => {
        if (!data?.entries) return
        const next: Record<string, WeatherSlateEntry> = {}
        for (const e of data.entries) {
          if (e.home_team) next[e.home_team] = e
        }
        setWeatherByHome(next)
      })
      .catch(() => {})
    return () => ac.abort()
  }, [visibleGames])

  function toProjections(params: { date: string; team?: string; player?: string }) {
    const qp = new URLSearchParams()
    qp.set('date', params.date)
    if (params.team) qp.set('team', params.team)
    if (params.player) qp.set('player', params.player)
    return `/projections?${qp.toString()}`
  }

  function formatGameStatus(live: any): string {
    if (!live) return ''
    const raw = String(live.status ?? '').replace(/^STATUS_/i, '').replace(/_/g, ' ')
    const lower = raw.toLowerCase()
    if (/final/i.test(lower)) return 'Final'
    if (/scheduled|pre-game|not started/i.test(lower)) {
      if (live.start_time_utc) {
        return new Date(live.start_time_utc).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      }
      return 'Scheduled'
    }
    const awayInnings = Array.isArray(live.away_inning_scores) ? live.away_inning_scores.length : 0
    const homeInnings = Array.isArray(live.home_inning_scores) ? live.home_inning_scores.length : 0
    if (awayInnings > 0 || homeInnings > 0) {
      const half = awayInnings > homeInnings ? 'Bot' : 'Top'
      const inn = Math.max(awayInnings, homeInnings)
      const ord = inn === 1 ? '1st' : inn === 2 ? '2nd' : inn === 3 ? '3rd' : `${inn}th`
      return `${half} ${ord}`
    }
    if (/progress|live|in progress/i.test(lower)) return 'In Progress'
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
  }

  function initials(name: string | null | undefined): string {
    const n = (name ?? '').trim()
    if (!n) return '—'
    const commaParts = n.split(',').map((s) => s.trim()).filter(Boolean)
    if (commaParts.length >= 2) {
      return `${commaParts[1][0] ?? ''}${commaParts[0][0] ?? ''}`.toUpperCase()
    }
    const parts = n.split(/\s+/).filter(Boolean)
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase()
  }

  async function openMatchup(r: DailyProjection) {
    setMatchupFor(r)
    setMatchupData(null)
    setPlayerInputs(null)
    const match = String(r.opponent ?? '').match(/(?:vs|@)\s+([A-Za-z]{2,4})/i)
    const opponentTeam = normalizeTeamCode(match?.[1] ?? '') ?? ''
    if (!opponentTeam) return
    setMatchupLoading(true)
    try {
      const base = import.meta.env.VITE_API_BASE_URL ?? ''
      const q = new URLSearchParams({
        player_id: r.playerId,
        opponent_team: opponentTeam,
        season: String(selectedYear),
      })
      if (r.opponentPitcher) q.set('pitcher_name', r.opponentPitcher)
      const [matchupRes, evRes, hrRes] = await Promise.all([
        fetch(`${base}/bdl/matchup-card?${q.toString()}`),
        supabase
          ?.from('stats_exit_velocity')
          .select('avg_hit_speed,ev95percent,brl_percent,fbld,attempts,season')
          .eq('role', 'batting')
          .eq('player_id', r.playerId)
          .eq('season', selectedYear)
          .order('season', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          ?.from('stats_homeruns')
          .select('hr_total,year')
          .eq('role', 'batting')
          .eq('type', 'adj_xhr')
          .eq('player_id', r.playerId)
          .eq('year', selectedYear)
          .order('year', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
      const payload = await matchupRes.json()
      setMatchupData(payload?.data ?? null)
      let evData = evRes?.data
      let hrData = hrRes?.data
      if (!evData?.avg_hit_speed && !hrData?.hr_total && selectedYear !== 2025) {
        const [evFallback, hrFallback] = await Promise.all([
          supabase
            ?.from('stats_exit_velocity')
            .select('avg_hit_speed,ev95percent,brl_percent,fbld,attempts,season')
            .eq('role', 'batting')
            .eq('player_id', r.playerId)
            .eq('season', 2025)
            .limit(1)
            .maybeSingle(),
          supabase
            ?.from('stats_homeruns')
            .select('hr_total,year')
            .eq('role', 'batting')
            .eq('type', 'adj_xhr')
            .eq('player_id', r.playerId)
            .eq('year', 2025)
            .limit(1)
            .maybeSingle(),
        ])
        if (evFallback?.data?.avg_hit_speed || hrFallback?.data?.hr_total) {
          evData = evFallback?.data
          hrData = hrFallback?.data
        }
      }
      setPlayerInputs({
        avg_hit_speed: evData?.avg_hit_speed ?? null,
        ev95percent: evData?.ev95percent ?? null,
        brl_percent: evData?.brl_percent ?? null,
        fbld: evData?.fbld ?? null,
        attempts: evData?.attempts ?? null,
        hr_total: hrData?.hr_total ?? null,
        season: evData?.season ?? hrData?.year ?? null,
      })
    } catch {
      setMatchupData(null)
      setPlayerInputs(null)
    } finally {
      setMatchupLoading(false)
    }
  }

  async function fetchLineup(bdlGameId: string) {
    if (lineupByGame[bdlGameId] !== undefined) return // already fetched
    const base = import.meta.env.VITE_API_BASE_URL ?? ''
    if (!base) return
    setLineupLoadingFor(bdlGameId)
    try {
      const r = await fetch(`${base}/bdl/lineup?game_id=${bdlGameId}`)
      const json = await r.json()
      setLineupByGame((prev) => ({ ...prev, [bdlGameId]: json?.data ?? null }))
    } catch {
      setLineupByGame((prev) => ({ ...prev, [bdlGameId]: null }))
    } finally {
      setLineupLoadingFor(null)
    }
  }

  async function loadPicks() {
    if (!supabase || !session?.user.id) {
      setPickState({})
      return
    }
    const { data } = await supabase
      .from('user_daily_picks')
      .select('player_id,hit')
      .eq('user_id', session.user.id)
      .eq('pick_date', displayDate)
    const next: Record<string, boolean | null> = {}
    for (const r of (data ?? []) as Array<{ player_id: string; hit: boolean | null }>) {
      next[String(r.player_id)] = r.hit
    }
    setPickState(next)
  }

  useEffect(() => {
    void loadPicks()
  }, [displayDate, session?.user.id, supabase])

  useEffect(() => {
    if (!supabase || !session?.user.id) return
    const id = setInterval(() => void loadPicks(), 30000)
    return () => clearInterval(id)
  }, [displayDate, session?.user.id, supabase])

  useEffect(() => {
    const onChanged = (ev: Event) => {
      const detail = (ev as CustomEvent<{ date?: string }>).detail
      if (!detail?.date || detail.date === displayDate) void loadPicks()
    }
    window.addEventListener('ah:picks-changed', onChanged as EventListener)
    return () => window.removeEventListener('ah:picks-changed', onChanged as EventListener)
  }, [displayDate])

  function pickStatusLabel(v: boolean | null | undefined): string {
    if (v === true) return 'HIT'
    if (v === false) return 'MISS'
    if (v === null) return 'PENDING'
    return ''
  }

  async function togglePick(playerId: string) {
    if (!supabase || !session?.user.id) {
      setPickMsg('Sign in to use targets.')
      return
    }
    const player = rows.find((r) => r.playerId === playerId)
    const team = normalizeTeamCode(player?.team ?? '')
    const locked = liveGames.some((g) => {
      const a = normalizeTeamCode(g.away_team_abbrev ?? '')
      const h = normalizeTeamCode(g.home_team_abbrev ?? '')
      const status = String(g.status ?? '').toLowerCase()
      const started = !/scheduled|pre|not started/.test(status)
      return started && (team === a || team === h)
    })
    if (locked) {
      setPickMsg('Game already started. Picks are locked for players in active/final games.')
      return
    }

    if (pickBusy) return
    setPickMsg('')
    setPickBusy(playerId)

    const currentlyPicked = Object.prototype.hasOwnProperty.call(pickState, playerId)
    if (currentlyPicked) {
      const { error } = await supabase
        .from('user_daily_picks')
        .delete()
        .eq('user_id', session.user.id)
        .eq('pick_date', displayDate)
        .eq('player_id', playerId)
      if (error) setPickMsg(error.message)
      else {
        const next = { ...pickState }
        delete next[playerId]
        setPickState(next)
        window.dispatchEvent(new CustomEvent('ah:picks-changed', { detail: { date: displayDate } }))
      }
      setPickBusy(null)
      return
    }

    if (Object.keys(pickState).length >= 3) {
      setPickBusy(null)
      setPickMsg('You can target up to 3 players per day.')
      return
    }

    const { error } = await supabase.from('user_daily_picks').insert({
      user_id: session.user.id,
      pick_date: displayDate,
      player_id: playerId,
    })
    if (error) setPickMsg(error.message)
    else {
      setPickState((prev) => ({ ...prev, [playerId]: null }))
      window.dispatchEvent(new CustomEvent('ah:picks-changed', { detail: { date: displayDate } }))
    }
    setPickBusy(null)
  }

  return (
    <div className="pg">
      <h1 className="pg-title">Dugout</h1>
      <div className="pg-controls">
        <label htmlFor="dugout-date" className="pg-label">
          Date
        </label>
        <input
          id="dugout-date"
          className="pg-date"
          type="date"
          value={displayDate}
          min={availableDates[0]}
          max={availableDates[availableDates.length - 1]}
          onChange={(e) => setDisplayDate(e.target.value)}
        />
        <label htmlFor="dugout-year" className="pg-label">Year</label>
        <select
          id="dugout-year"
          className="acc-select"
          value={selectedYear}
          onChange={(e) => setSelectedYear(Number(e.target.value))}
        >
          {[2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019].map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>
      <p className="pg-sub">
        {displayDate} &mdash; {visibleGames.length} game{visibleGames.length !== 1 ? 's' : ''}{' '}
        on the slate
      </p>
      {!hasSubscription ? (
        <p className="pg-sub">Free preview: one random game. Subscribe to unlock full slate.</p>
      ) : null}
      {session ? (
        <p className="pg-sub">Targets used: {Object.keys(pickState).length}/3 {pickMsg ? `— ${pickMsg}` : ''}</p>
      ) : (
        <p className="pg-sub">Sign in to select up to 3 daily targets.</p>
      )}
      {loading ? (
        <div className="lb-skel">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="lb-skelRow" />
          ))}
        </div>
      ) : rows.length === 0 && games.length === 0 ? (
        <p className="pg-empty">No games scheduled or projection data for {displayDate}.</p>
      ) : (
        <>
          <section className="pg-section">
            <h2 className="pg-sectionTitle">Games today</h2>
            {visibleGames.length === 0 ? (
              <p className="pg-empty">No games on the schedule for this date.</p>
            ) : (
              <div className="pg-cards">
                {visibleGames.map((g) => {
                  const pairKey = [normalizeTeamCode(g.homeTeam) ?? g.homeTeam, normalizeTeamCode(g.awayTeam) ?? g.awayTeam].sort().join('|')
                  const live =
                    liveGames.find(
                      (lg) =>
                        String(lg.bdl_game_id ?? '') === g.gameId &&
                        bdlRowMatchesCalendarDay(lg, displayDate),
                    ) ??
                    liveGames.find(
                      (lg) =>
                        bdlRowMatchesCalendarDay(lg, displayDate) &&
                        [normalizeTeamCode(lg.home_team_abbrev) ?? lg.home_team_abbrev, normalizeTeamCode(lg.away_team_abbrev) ?? lg.away_team_abbrev].sort().join('|') ===
                          pairKey,
                    ) ??
                    null
                  const status = String(live?.status ?? '').toLowerCase()
                  const gameStarted = !!live && !/scheduled|pre|not started/.test(status)
                  const awayKey = normalizeTeamCode(g.awayTeam) ?? g.awayTeam
                  const homeKey = normalizeTeamCode(g.homeTeam) ?? g.homeTeam
                  const awayTop = topByTeam.get(awayKey)
                  const homeTop = topByTeam.get(homeKey)
                  const awayPalette = paletteForTeam(awayTop?.team ?? g.awayTeam)
                  const homePalette = paletteForTeam(homeTop?.team ?? g.homeTeam)
                  const isExpanded = expandedGameId === g.gameId
                  const homeNorm = normalizeTeamCode(g.homeTeam) ?? g.homeTeam
                  const wxLine = formatBallparkWx(weatherByHome[homeNorm])
                  return (
                    <div
                      key={g.gameId}
                      className="pg-card pg-card--stack"
                    >
                      <div className="pg-summary">
                        <div className="pg-summaryTop">
                          <div className="pg-gameCenter">
                            <Link
                              className="pg-link pg-gameTeams"
                              style={{ color: 'var(--color-text)', textShadow: '0 1px 2px rgba(0,0,0,0.75)' }}
                              to={toProjections({ date: displayDate })}
                            >
                              {g.awayTeam} @ {g.homeTeam}
                            </Link>
                          </div>
                          <div className="pg-weather">
                            {formatGameStatus(live) || (live?.start_time_utc ? new Date(live.start_time_utc).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'TBD')}
                          </div>
                        </div>
                        {wxLine ? (
                          <div className="pg-sub" style={{ marginTop: 6 }} title={weatherByHome[homeNorm]?.stadium ?? ''}>
                            {wxLine}
                          </div>
                        ) : null}
                        {gameStarted ? (
                          <div className="pg-gameRows">
                            {(() => {
                              const awayInn: number[] = Array.isArray(live?.away_inning_scores) ? live.away_inning_scores : []
                              const homeInn: number[] = Array.isArray(live?.home_inning_scores) ? live.home_inning_scores : []
                              const maxInn = Math.max(awayInn.length, homeInn.length, 9)
                              const cols = Array.from({ length: maxInn }, (_, i) => i)
                              return (
                                <div className="pg-scoreboardWrap">
                                  <table className="pg-scoreboard pg-scoreboard--linescore">
                                    <thead>
                                      <tr>
                                        <th style={{ textAlign: 'left' }}></th>
                                        {cols.map((i) => <th key={i}>{i + 1}</th>)}
                                        <th className="pg-scoreboard-totals">R</th>
                                        <th className="pg-scoreboard-totals">H</th>
                                        <th className="pg-scoreboard-totals">E</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      <tr>
                                        <td className="pg-scoreboardTeamAbbrev">{g.awayTeam}</td>
                                        {cols.map((i) => <td key={i}>{i < awayInn.length ? awayInn[i] : '-'}</td>)}
                                        <td className="pg-scoreboard-totals">{live?.away_score ?? 0}</td>
                                        <td className="pg-scoreboard-totals">{live?.away_hits ?? 0}</td>
                                        <td className="pg-scoreboard-totals">{live?.away_errors ?? 0}</td>
                                      </tr>
                                      <tr>
                                        <td className="pg-scoreboardTeamAbbrev">{g.homeTeam}</td>
                                        {cols.map((i) => <td key={i}>{i < homeInn.length ? homeInn[i] : '-'}</td>)}
                                        <td className="pg-scoreboard-totals">{live?.home_score ?? 0}</td>
                                        <td className="pg-scoreboard-totals">{live?.home_hits ?? 0}</td>
                                        <td className="pg-scoreboard-totals">{live?.home_errors ?? 0}</td>
                                      </tr>
                                    </tbody>
                                  </table>
                                </div>
                              )
                            })()}
                            <div className="pg-label pg-scoringPlaysTitle" style={{ marginTop: 10 }}>Scoring Plays</div>
                            {(() => {
                              const playsAll = Array.isArray(live?.scoring_summary) ? [...live.scoring_summary].reverse() : []
                              const isHr = (txt: string) => /home run|homer|grand slam/i.test(txt)
                              const hrPlays = playsAll.filter((p: any) => isHr(String(p?.play ?? '')))
                              if (!hrPlays.length) return <div className="pg-sub">No home runs yet.</div>
                              return (
                                <div className="pg-scoringPlays">
                                  {hrPlays.map((p: any, i: number) => {
                                    const txt = String(p?.play ?? '')
                                    // BDL scoring summary has `inning` + `period`, but sometimes the meaning is swapped.
                                    // We infer half inning from whichever field contains TOP/BOTTOM and inning number from the other.
                                    const inningRaw = String(p?.inning ?? '').trim()
                                    const periodRaw = String(p?.period ?? '').trim()
                                    const inningLower = inningRaw.toLowerCase()
                                    const periodLower = periodRaw.toLowerCase()

                                    let half: 'Top' | 'Bot' | '' = ''
                                    let inningNum = ''
                                    const toOrdinal = (n: number) => {
                                      if (n === 1) return '1st'
                                      if (n === 2) return '2nd'
                                      if (n === 3) return '3rd'
                                      return `${n}th`
                                    }

                                    if (/top/.test(inningLower)) {
                                      half = 'Top'
                                      inningNum = periodRaw
                                    } else if (/bot/.test(inningLower)) {
                                      half = 'Bot'
                                      inningNum = periodRaw
                                    } else if (/top/.test(periodLower)) {
                                      half = 'Top'
                                      inningNum = inningRaw
                                    } else if (/bot/.test(periodLower)) {
                                      half = 'Bot'
                                      inningNum = inningRaw
                                    } else {
                                      inningNum = inningRaw || periodRaw
                                    }

                                    const nStr = String(inningNum).replace(/[^0-9]/g, '')
                                    const n = nStr ? Number(nStr) : null
                                    const inningLabel = half && n
                                      ? `${half} ${toOrdinal(n)}`
                                      : half
                                        ? half
                                        : n
                                          ? toOrdinal(n)
                                          : (inningRaw || periodRaw)
                                    const lower = txt.toLowerCase()
                                    const dir =
                                      /left center|to left|left field|left-only|left-center|left/.test(lower)
                                        ? 'left'
                                        : /right center|to right|right field|right-only|right-center|right/.test(lower)
                                          ? 'right'
                                          : /center field|to center|center/.test(lower)
                                            ? 'center'
                                            : 'center'

                                    const iconSrc = dir === 'center' ? hrIcon64 : hrIcon96
                                    const iconClass =
                                      dir === 'left' ? 'pg-scoringPlayHrIcon pg-scoringPlayHrIcon--left' : 'pg-scoringPlayHrIcon'

                                    return (
                                      <div key={i} className="pg-scoringPlay pg-scoringPlay--hr">
                                        <span className="pg-scoringPlayIcon" aria-hidden="true">
                                          <img className={iconClass} src={iconSrc} alt="" />
                                        </span>
                                        <span className="pg-scoringPlayText">{txt}</span>
                                        <span className="pg-scoringPlayInning">{inningLabel}</span>
                                      </div>
                                    )
                                  })}
                                </div>
                              )
                            })()}
                          </div>
                        ) : (
                        <div className="pg-batterRow">
                          {(() => {
                            const lineupKey = `${awayKey}@${homeKey}`
                            const cached = cachedLineups[lineupKey]
                            const awayLeadoff = cached?.away?.players?.[0] ?? null
                            const homeLeadoff = cached?.home?.players?.[0] ?? null
                            const awayLineupSource = cached?.away?.source ?? 'none'
                            const homeLineupSource = cached?.home?.source ?? 'none'
                            const awayName = awayTop?.name ?? awayLeadoff?.full_name ?? null
                            const homeName = homeTop?.name ?? homeLeadoff?.full_name ?? null
                            const awayIsProjected = !awayTop && !!awayLeadoff
                            const homeIsProjected = !homeTop && !!homeLeadoff

                            return (
                              <>
                                <div className="pg-batterCol pg-batterCol--left">
                                  <div className="pg-batterTop">
                                    <span
                                      className="pg-avatar"
                                      aria-hidden="true"
                                      style={{
                                        background: `linear-gradient(140deg, ${awayPalette.primary}, ${awayPalette.secondary})`,
                                        color: awayPalette.bg,
                                      }}
                                    >
                                      {initials(awayName)}
                                    </span>
                                    <Link
                                      className="pg-link pg-teamLink"
                                      to={toProjections({ date: displayDate, team: g.awayTeam })}
                                      style={teamAbbrevContrastStyle(awayPalette)}
                                    >
                                      {g.awayTeam}
                                    </Link>
                                  </div>
                                  <div>
                                    {awayTop ? (
                                      <div className="pg-pickPlayerRow">
                                        <button
                                          type="button"
                                          className={`pg-targetBtn ${Object.prototype.hasOwnProperty.call(pickState, awayTop.playerId) ? 'is-selected' : ''}`}
                                          disabled={pickBusy === awayTop.playerId}
                                          onClick={() => void togglePick(awayTop.playerId)}
                                        >
                                          🎯
                                        </button>
                                        <button
                                          type="button"
                                          className="pg-playerSelect"
                                          onClick={() => void openMatchup(awayTop)}
                                        >
                                          {awayTop.name}
                                        </button>
                                      </div>
                                    ) : awayName ? (
                                      <div className="pg-pickPlayerRow">
                                        <span className="pg-lineupName pg-lineupName--plain">{awayName}</span>
                                        {awayIsProjected && <span className="pg-lineupBadge">{awayLineupSource === 'yesterday' ? 'Yesterday' : 'Projected'}</span>}
                                      </div>
                                    ) : (
                                      <span className="pg-gamePick--muted">—</span>
                                    )}
                                  </div>
                                  <div className="pg-batterProb">
                                    <span style={{ color: awayPalette.primary }}>
                                      {awayTop ? formatProbability(awayTop.hrProbability) : '—'}
                                    </span>
                                    {awayTop?.americanOddsStr ? (
                                      <span className="pg-batterOdds">{awayTop.americanOddsStr}</span>
                                    ) : null}
                                    {awayTop && playerOdds[awayTop.playerId] != null ? (
                                      <span className="pg-batterBookOdds" title={`${defaultSportsbook} HR odds`}>
                                        {defaultSportsbook.charAt(0).toUpperCase() + defaultSportsbook.slice(1)}{' '}
                                        {playerOdds[awayTop.playerId]! >= 0 ? `+${playerOdds[awayTop.playerId]}` : String(playerOdds[awayTop.playerId])}
                                      </span>
                                    ) : null}
                                    {awayTop && Object.prototype.hasOwnProperty.call(pickState, awayTop.playerId) ? (
                                      <span className={`pg-pickState ${String(pickState[awayTop.playerId] ?? 'pending')}`}>
                                        {pickStatusLabel(pickState[awayTop.playerId])}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="pg-batterCol pg-batterCol--right">
                                  <div className="pg-batterTop pg-batterTop--right">
                                    <Link
                                      className="pg-link pg-teamLink"
                                      to={toProjections({ date: displayDate, team: g.homeTeam })}
                                      style={teamAbbrevContrastStyle(homePalette)}
                                    >
                                      {g.homeTeam}
                                    </Link>
                                    <span
                                      className="pg-avatar"
                                      aria-hidden="true"
                                      style={{
                                        background: `linear-gradient(140deg, ${homePalette.primary}, ${homePalette.secondary})`,
                                        color: homePalette.bg,
                                      }}
                                    >
                                      {initials(homeName)}
                                    </span>
                                  </div>
                                  <div>
                                    {homeTop ? (
                                      <div className="pg-pickPlayerRow pg-pickPlayerRow--right">
                                        <button
                                          type="button"
                                          className="pg-playerSelect"
                                          onClick={() => void openMatchup(homeTop)}
                                        >
                                          {homeTop.name}
                                        </button>
                                        <button
                                          type="button"
                                          className={`pg-targetBtn ${Object.prototype.hasOwnProperty.call(pickState, homeTop.playerId) ? 'is-selected' : ''}`}
                                          disabled={pickBusy === homeTop.playerId}
                                          onClick={() => void togglePick(homeTop.playerId)}
                                        >
                                          🎯
                                        </button>
                                      </div>
                                    ) : homeName ? (
                                      <div className="pg-pickPlayerRow pg-pickPlayerRow--right">
                                        <span className="pg-lineupName pg-lineupName--plain">{homeName}</span>
                                        {homeIsProjected && <span className="pg-lineupBadge">{homeLineupSource === 'yesterday' ? 'Yesterday' : 'Projected'}</span>}
                                      </div>
                                    ) : (
                                      <span className="pg-gamePick--muted">—</span>
                                    )}
                                  </div>
                                  <div className="pg-batterProb">
                                    <span style={{ color: homePalette.primary }}>
                                      {homeTop ? formatProbability(homeTop.hrProbability) : '—'}
                                    </span>
                                    {homeTop?.americanOddsStr ? (
                                      <span className="pg-batterOdds">{homeTop.americanOddsStr}</span>
                                    ) : null}
                                    {homeTop && playerOdds[homeTop.playerId] != null ? (
                                      <span className="pg-batterBookOdds" title={`${defaultSportsbook} HR odds`}>
                                        {defaultSportsbook.charAt(0).toUpperCase() + defaultSportsbook.slice(1)}{' '}
                                        {playerOdds[homeTop.playerId]! >= 0 ? `+${playerOdds[homeTop.playerId]}` : String(playerOdds[homeTop.playerId])}
                                      </span>
                                    ) : null}
                                    {homeTop && Object.prototype.hasOwnProperty.call(pickState, homeTop.playerId) ? (
                                      <span className={`pg-pickState ${String(pickState[homeTop.playerId] ?? 'pending')}`}>
                                        {pickStatusLabel(pickState[homeTop.playerId])}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              </>
                            )
                          })()}
                        </div>
                        )}
                      </div>

                      <button
                        type="button"
                        className="pg-expandBtn"
                        onClick={() => {
                          const nextExpanded = isExpanded ? null : g.gameId
                          setExpandedGameId(nextExpanded)
                          if (nextExpanded && live?.bdl_game_id) {
                            void fetchLineup(String(live.bdl_game_id))
                          }
                        }}
                      >
                        {isExpanded ? 'Hide details' : 'Expand details'}
                      </button>

                      {isExpanded ? (
                        <div className="pg-detailWrap">
                          <div className="pg-gameRows">
                            {/* Probable pitchers — BDL feed takes priority, fallback to projection data */}
                            {(() => {
                              const bdlPitchers = live?.bdl_game_id ? probablePitchers[String(live.bdl_game_id)] : null
                              // BDL: home pitcher faces away batters; away pitcher faces home batters
                              const awayTeamPitcher = bdlPitchers?.home ?? homeTop?.opponentPitcher
                              const awayTeamPitcherHand = bdlPitchers ? null : homeTop?.opponentPitcherHand
                              const homeTeamPitcher = bdlPitchers?.away ?? awayTop?.opponentPitcher
                              const homeTeamPitcherHand = bdlPitchers ? null : awayTop?.opponentPitcherHand
                              return (
                                <div className="pg-gameLine">
                                  <span className="pg-gameLabel">Probable pitchers{bdlPitchers ? ' ✓' : ''}</span>
                                  <span className="pg-gameValue">
                                    {g.awayTeam}: {awayTeamPitcher ? `${awayTeamPitcher}${awayTeamPitcherHand ? ` (${awayTeamPitcherHand})` : ''}` : '—'}
                                    {' · '}
                                    {g.homeTeam}: {homeTeamPitcher ? `${homeTeamPitcher}${homeTeamPitcherHand ? ` (${homeTeamPitcherHand})` : ''}` : '—'}
                                  </span>
                                </div>
                              )
                            })()}

                            {/* Lineup — BDL official when available, projected fallback */}
                            {(() => {
                              const bdlGameIdStr = live?.bdl_game_id ? String(live.bdl_game_id) : null
                              const bdlLineup = bdlGameIdStr ? lineupByGame[bdlGameIdStr] : undefined
                              const isLoadingLineup = bdlGameIdStr === lineupLoadingFor

                              const ordinal = (n: number) =>
                                n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`

                              if (isLoadingLineup) {
                                return <div className="pg-sub" style={{ marginTop: 12 }}>Loading lineup…</div>
                              }

                              if (bdlLineup) {
                                // Official BDL lineup
                                const renderBdlTeam = (
                                  entries: typeof bdlLineup.away,
                                  teamCode: string,
                                ) => {
                                  const batters = entries.filter((e) => e.batting_order != null && e.batting_order > 0)
                                  const pitcher = entries.find((e) => !e.batting_order || e.batting_order === 0)
                                  return (
                                    <div className="pg-lineupTeam">
                                      <div className="pg-lineupTeamTitle">{teamCode}</div>
                                      {batters.map((p, idx) => {
                                        const proj = p.stat_player_id
                                          ? rows.find((r) => r.playerId === p.stat_player_id)
                                          : null
                                        const hasPick = proj && Object.prototype.hasOwnProperty.call(pickState, proj.playerId)
                                        return (
                                          <div key={p.bdl_player_id ?? idx} className="pg-lineupRow">
                                            <span className="pg-lineupOrder">{ordinal(idx + 1)}</span>
                                            <span className="pg-lineupPos">{String(p.position ?? '—').toUpperCase().slice(0, 3)}</span>
                                            {proj ? (
                                              <button
                                                type="button"
                                                className="pg-lineupName"
                                                onClick={() => void openMatchup(proj)}
                                              >
                                                {p.full_name ?? proj.name}
                                              </button>
                                            ) : (
                                              <span className="pg-lineupName pg-lineupName--plain">{p.full_name ?? '—'}</span>
                                            )}
                                            <span className="pg-lineupProj">
                                              {proj ? formatProbability(proj.hrProbability) : '—'}
                                            </span>
                                            {proj ? (
                                              <button
                                                type="button"
                                                className={`pg-targetBtn ${hasPick ? 'is-selected' : ''}`}
                                                disabled={pickBusy === proj.playerId}
                                                onClick={() => void togglePick(proj.playerId)}
                                              >
                                                🎯
                                              </button>
                                            ) : <span style={{ width: 32 }} />}
                                          </div>
                                        )
                                      })}
                                      {pitcher && (
                                        <div className="pg-lineupRow pg-lineupRow--pitcher">
                                          <span className="pg-lineupOrder">P</span>
                                          <span className="pg-lineupPos">SP</span>
                                          <span className="pg-lineupName pg-lineupName--plain">{pitcher.full_name ?? '—'}</span>
                                          <span className="pg-lineupProj" />
                                          <span style={{ width: 32 }} />
                                        </div>
                                      )}
                                    </div>
                                  )
                                }
                                return (
                                  <div className="pg-lineupGrid" style={{ marginTop: 12 }}>
                                    {renderBdlTeam(bdlLineup.away, g.awayTeam)}
                                    {renderBdlTeam(bdlLineup.home, g.homeTeam)}
                                  </div>
                                )
                              }

                              // Projected fallback — try daily projections first, then cached lineups
                              const toTeamKey = (t: string | null | undefined) => normalizeTeamCode(t ?? '') ?? t ?? ''
                              const detailAwayKey = normalizeTeamCode(g.awayTeam) ?? g.awayTeam
                              const detailHomeKey = normalizeTeamCode(g.homeTeam) ?? g.homeTeam
                              const awayLineup = rows.filter((p) => toTeamKey(p.team) === detailAwayKey).slice().sort((a, b) => (b.hrProbability ?? -1) - (a.hrProbability ?? -1))
                              const homeLineup = rows.filter((p) => toTeamKey(p.team) === detailHomeKey).slice().sort((a, b) => (b.hrProbability ?? -1) - (a.hrProbability ?? -1))

                              const detailLineupKey = `${detailAwayKey}@${detailHomeKey}`
                              const detailCached = cachedLineups[detailLineupKey]

                              if (!awayLineup.length && !homeLineup.length && !detailCached) {
                                return (
                                  <div className="pg-sub" style={{ marginTop: 12 }}>
                                    Lineup not posted yet.{bdlGameIdStr && bdlLineup === null ? ' BDL returned no lineup for this game.' : ''}
                                  </div>
                                )
                              }

                              if (awayLineup.length || homeLineup.length) {
                                const renderProjTeam = (lineup: typeof awayLineup, teamCode: string) => (
                                  <div className="pg-lineupTeam">
                                    <div className="pg-lineupTeamTitle">{teamCode} <span className="pg-lineupBadge">Projected</span></div>
                                    {lineup.map((p, idx) => {
                                      const hasPick = Object.prototype.hasOwnProperty.call(pickState, p.playerId)
                                      return (
                                        <div key={p.playerId} className="pg-lineupRow">
                                          <span className="pg-lineupOrder">{ordinal(idx + 1)}</span>
                                          <span className="pg-lineupPos">{String(p.position ?? '—').toUpperCase().slice(0, 3)}</span>
                                          <button type="button" className="pg-lineupName" onClick={() => void openMatchup(p)}>
                                            {p.name}
                                          </button>
                                          <span className="pg-lineupProj">{formatProbability(p.hrProbability)}</span>
                                          <button
                                            type="button"
                                            className={`pg-targetBtn ${hasPick ? 'is-selected' : ''}`}
                                            disabled={pickBusy === p.playerId}
                                            onClick={() => void togglePick(p.playerId)}
                                          >
                                            🎯
                                          </button>
                                        </div>
                                      )
                                    })}
                                  </div>
                                )

                                return (
                                  <div className="pg-lineupGrid" style={{ marginTop: 12 }}>
                                    {renderProjTeam(awayLineup, g.awayTeam)}
                                    {renderProjTeam(homeLineup, g.homeTeam)}
                                  </div>
                                )
                              }

                              // Fall back to cached lineups (yesterday's or confirmed)
                              const renderCachedTeam = (team: CachedLineupTeam, teamCode: string) => {
                                if (!team?.players?.length) return null
                                const badgeLabel = team.source === 'confirmed' ? 'Confirmed' : team.source === 'yesterday' ? "Yesterday's Lineup" : 'Projected'
                                return (
                                  <div className="pg-lineupTeam">
                                    <div className="pg-lineupTeamTitle">{teamCode} <span className="pg-lineupBadge">{badgeLabel}</span></div>
                                    {team.players
                                      .filter((p: any) => p.batting_order != null && p.batting_order > 0)
                                      .map((p: any, idx: number) => {
                                        const proj = p.stat_player_id ? rows.find((r) => r.playerId === p.stat_player_id) : null
                                        return (
                                          <div key={p.bdl_player_id ?? idx} className="pg-lineupRow">
                                            <span className="pg-lineupOrder">{ordinal(idx + 1)}</span>
                                            <span className="pg-lineupPos">{String(p.position ?? '—').toUpperCase().slice(0, 3)}</span>
                                            {proj ? (
                                              <button type="button" className="pg-lineupName" onClick={() => void openMatchup(proj)}>
                                                {p.full_name ?? proj.name}
                                              </button>
                                            ) : (
                                              <span className="pg-lineupName pg-lineupName--plain">{p.full_name ?? '—'}</span>
                                            )}
                                            <span className="pg-lineupProj">{proj ? formatProbability(proj.hrProbability) : '—'}</span>
                                            <span style={{ width: 32 }} />
                                          </div>
                                        )
                                      })}
                                  </div>
                                )
                              }

                              return (
                                <div className="pg-lineupGrid" style={{ marginTop: 12 }}>
                                  {detailCached?.away ? renderCachedTeam(detailCached.away, g.awayTeam) : null}
                                  {detailCached?.home ? renderCachedTeam(detailCached.home, g.homeTeam) : null}
                                </div>
                              )
                            })()}

                            <div className="pg-gameLine" style={{ marginTop: 12 }}>
                              <span className="pg-gameLabel">Projections</span>
                              <span className="pg-gameValue">
                                <Link className="pg-link pg-teamLink" to={toProjections({ date: displayDate })}>
                                  View full matchup board
                                </Link>
                              </span>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </>
      )}
      {matchupFor ? (
        <div className="pg-modalBackdrop" onClick={() => setMatchupFor(null)}>
          <div className="pg-modal pg-modal--matchup" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="pg-modalHead">
              <h3 className="pg-modalTitle">
                {matchupFor.name}
                <span className="pg-modalVs"> vs </span>
                {matchupData?.pitcher_name ?? (matchupFor.opponentPitcher ?? matchupFor.opponent)}
              </h3>
              <button type="button" className="pg-clearBtn" onClick={() => setMatchupFor(null)}>✕ Close</button>
            </div>

            {matchupLoading ? (
              <p className="pg-sub" style={{ padding: '24px 0', textAlign: 'center' }}>Loading matchup…</p>
            ) : (
              <div className="pg-matchupBody">
                {/* Player headers: pitcher left, batter right */}
                <div className="pg-matchupPlayers">
                  <div className="pg-matchupPlayerCard pg-matchupPlayerCard--pitcher">
                    <div
                      className="pg-avatar pg-avatar--lg"
                      style={{ background: 'linear-gradient(140deg, #334155, #1e293b)', color: '#94a3b8' }}
                    >
                      {initials(matchupData?.pitcher_name ?? matchupFor.opponentPitcher)}
                    </div>
                    <div className="pg-matchupPlayerInfo">
                      <div className="pg-matchupRole">Pitcher</div>
                      <div className="pg-matchupPlayerName">{matchupData?.pitcher_name ?? matchupFor.opponentPitcher ?? '—'}</div>
                    </div>
                  </div>
                  <div className="pg-matchupVsDivider">VS</div>
                  <div className="pg-matchupPlayerCard pg-matchupPlayerCard--batter">
                    <div
                      className="pg-avatar pg-avatar--lg"
                      style={{ background: 'linear-gradient(140deg, #1e3a5f, #0f2847)', color: '#60a5fa' }}
                    >
                      {initials(matchupFor.name)}
                    </div>
                    <div className="pg-matchupPlayerInfo">
                      <div className="pg-matchupRole">Batter</div>
                      <div className="pg-matchupPlayerName">{matchupFor.name}</div>
                    </div>
                  </div>
                </div>

                {/* BvP — batter vs pitcher career history */}
                {matchupData?.sample_ab ? (
                  <div className="pg-bvpSection">
                    <div className="pg-bvpLabel">Batter vs Pitcher (Career)</div>
                    <div className="pg-bvpGrid">
                      <div className="pg-bvpCell"><span className="pg-bvpVal">{matchupData.sample_ab}</span><span className="pg-bvpKey">AB</span></div>
                      <div className="pg-bvpCell"><span className="pg-bvpVal">{matchupData.h ?? 0}</span><span className="pg-bvpKey">H</span></div>
                      <div className="pg-bvpCell"><span className="pg-bvpVal pg-bvpVal--hr">{matchupData.hr ?? 0}</span><span className="pg-bvpKey">HR</span></div>
                      <div className="pg-bvpCell"><span className="pg-bvpVal">{matchupData.k ?? 0}</span><span className="pg-bvpKey">K</span></div>
                      <div className="pg-bvpCell"><span className="pg-bvpVal">{matchupData.avg ?? '—'}</span><span className="pg-bvpKey">AVG</span></div>
                      <div className="pg-bvpCell"><span className="pg-bvpVal">{matchupData.ops ?? '—'}</span><span className="pg-bvpKey">OPS</span></div>
                      <div className="pg-bvpCell"><span className="pg-bvpVal">{matchupData.slg ?? '—'}</span><span className="pg-bvpKey">SLG</span></div>
                    </div>
                  </div>
                ) : (
                  <div className="pg-bvpSection pg-bvpSection--empty">
                    <div className="pg-bvpLabel">Batter vs Pitcher</div>
                    <p className="pg-sub">No head-to-head history found.</p>
                  </div>
                )}

                {/* Stats: pitcher left, batter right */}
                <div className="pg-matchupStatsGrid">
                  {/* Pitcher stats */}
                  <div className="pg-matchupStatCol">
                    <div className="pg-matchupStatHead">Pitcher Stats ({matchupData?.season ?? selectedYear})</div>
                    <div className="pg-matchupStatRows">
                      {[
                        { label: 'ERA', val: matchupData?.pitcher_era, hint: '4.50+ favors HR', good: matchupData?.pitcher_era != null && Number(matchupData.pitcher_era) >= 4.5 },
                        { label: 'WHIP', val: matchupData?.pitcher_whip, hint: '1.30+ favors HR', good: matchupData?.pitcher_whip != null && Number(matchupData.pitcher_whip) >= 1.3 },
                        { label: 'HR Allowed', val: matchupData?.pitcher_hr_allowed, hint: '20+ favors HR', good: matchupData?.pitcher_hr_allowed != null && Number(matchupData.pitcher_hr_allowed) >= 20 },
                        { label: 'K/9', val: matchupData?.pitcher_k_per_9, hint: '8.0 or lower favors HR', good: matchupData?.pitcher_k_per_9 != null && Number(matchupData.pitcher_k_per_9) <= 8 },
                        { label: 'K', val: matchupData?.pitcher_k, hint: null, good: false },
                        { label: 'BB', val: matchupData?.pitcher_bb, hint: null, good: false },
                        { label: 'IP', val: matchupData?.pitcher_ip, hint: null, good: false },
                      ].map(({ label, val, hint, good }) => (
                        <div key={label} className={`pg-mStatRow ${good ? 'pg-mStatRow--good' : ''}`}>
                          <span className="pg-mStatLabel">{label}</span>
                          <span className="pg-mStatVal">{val ?? '—'}</span>
                          {hint && <span className="pg-mStatHint">{hint}</span>}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Batter stats */}
                  <div className="pg-matchupStatCol">
                    <div className="pg-matchupStatHead">Batter Stats ({matchupData?.season ?? playerInputs?.season ?? selectedYear})</div>
                    <div className="pg-matchupStatRows">
                      {[
                        { label: 'Avg EV', val: matchupData?.batter_avg_hit_speed ?? playerInputs?.avg_hit_speed, hint: '90+ mph ✓', good: (matchupData?.batter_avg_hit_speed ?? playerInputs?.avg_hit_speed) != null && Number(matchupData?.batter_avg_hit_speed ?? playerInputs?.avg_hit_speed) >= 90 },
                        { label: 'EV95', val: matchupData?.batter_ev95 ?? playerInputs?.ev95percent, hint: null, good: false },
                        { label: 'Barrel %', val: matchupData?.batter_barrel ?? playerInputs?.brl_percent, hint: '10%+ ✓', good: (matchupData?.batter_barrel ?? playerInputs?.brl_percent) != null && Number(matchupData?.batter_barrel ?? playerInputs?.brl_percent) >= 10 },
                        { label: 'Hard-hit %', val: matchupData?.batter_hard_hit, hint: '40%+ ✓', good: matchupData?.batter_hard_hit != null && Number(matchupData.batter_hard_hit) >= 40 },
                        { label: 'ISO', val: matchupData?.batter_iso != null ? Number(matchupData.batter_iso).toFixed(3) : null, hint: '.250+ ✓', good: matchupData?.batter_iso != null && Number(matchupData.batter_iso) >= 0.25 },
                        { label: 'FB/LD %', val: matchupData?.batter_fbld ?? playerInputs?.fbld, hint: '.45+ ✓', good: (matchupData?.batter_fbld ?? playerInputs?.fbld) != null && Number(matchupData?.batter_fbld ?? playerInputs?.fbld) >= 0.45 },
                        { label: 'K %', val: matchupData?.batter_k_pct != null ? `${(Number(matchupData.batter_k_pct) * 100).toFixed(1)}%` : null, hint: 'Lower is better', good: false },
                        { label: 'BB %', val: matchupData?.batter_bb_pct != null ? `${(Number(matchupData.batter_bb_pct) * 100).toFixed(1)}%` : null, hint: 'Higher is better', good: false },
                        { label: 'HR (season)', val: matchupData?.batter_season_hr ?? matchupData?.batter_hr ?? playerInputs?.hr_total, hint: null, good: false },
                      ].map(({ label, val, hint, good }) => (
                        <div key={label} className={`pg-mStatRow ${good ? 'pg-mStatRow--good' : ''}`}>
                          <span className="pg-mStatLabel">{label}</span>
                          <span className="pg-mStatVal">{val ?? '—'}</span>
                          {hint && <span className="pg-mStatHint">{hint}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Pitch type breakdown */}
                {Array.isArray(matchupData?.pitch_type_matchup) && matchupData.pitch_type_matchup.length > 0 && (
                  <div className="pg-pitchSection">
                    <div className="pg-matchupStatHead">Pitch Type Breakdown</div>
                    <div className="pg-pitchTypeGrid">
                      {matchupData.pitch_type_matchup.map((r: any, idx: number) => {
                        const iso = r?.batter_iso != null ? Number(r.batter_iso) : null
                        const usage = r?.usage != null ? Number(r.usage) : null
                        return (
                          <div key={idx} className={`pg-pitchTypeRow ${iso != null && iso >= 0.25 ? 'pg-pitchTypeRow--hot' : ''}`}>
                            <span className="pg-pitchName">{r?.pitch_name ?? r?.pitch_type ?? 'Pitch'}</span>
                            <span className="pg-pitchUsage">{usage != null ? `${usage.toFixed(0)}% usage` : '—'}</span>
                            <span className="pg-pitchStat">Batter ISO: {iso != null ? iso.toFixed(3) : '—'}</span>
                            <span className="pg-pitchStat">Pitcher SLG allowed: {r?.pitcher_slg_allowed != null ? Number(r.pitcher_slg_allowed).toFixed(3) : '—'}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {!matchupData && !playerInputs && (
                  <p className="pg-sub" style={{ marginTop: 16, textAlign: 'center' }}>No stats found for this player. Try a different year.</p>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
