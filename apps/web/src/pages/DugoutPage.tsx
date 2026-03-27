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
import { normalizeTeamCode, paletteForTeam } from '../theme/teamPalette'
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

  useEffect(() => {
    if (!supabase) return
    void getScheduleDates(supabase).then((dates) => {
      if (!dates.length) return
      setAvailableDates(dates)
      setDisplayDate((d) => (dates.includes(d) ? d : dates[0]))
    })
  }, [supabase])

  useEffect(() => {
    if (!supabase) return
    setLoading(true)
    void Promise.all([
      listDailyHrProjections(supabase, displayDate),
      getGamesForDate(supabase, displayDate),
      supabase
        .from('bdl_games')
        .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev,status,home_score,away_score,home_hits,away_hits,home_errors,away_errors,home_inning_scores,away_inning_scores,current_period,scoring_summary')
        .eq('date', displayDate),
    ])
      .then(([proj, sched, live]) => {
        setRows(proj)
        setGames(sched)
        const raw = (live.data ?? []) as any[]
        const dayIso = displayDate
        setLiveGames(
          raw.filter((lg) => {
            const d = lg.date
            if (d == null) return true
            return String(d).slice(0, 10) === dayIso
          }),
        )
      })
      .finally(() => setLoading(false))
  }, [supabase, displayDate])

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
          setLiveGames(raw.filter((lg) => {
            const d = lg.date
            if (d == null) return true
            return String(d).slice(0, 10) === dayIso
          }))
        })
    }, 60000)
    return () => clearInterval(id)
  }, [displayDate, supabase])

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
                    liveGames.find((lg) => String(lg.bdl_game_id ?? '') === g.gameId) ??
                    liveGames.find(
                      (lg) =>
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
                                        <td>{g.awayTeam}</td>
                                        {cols.map((i) => <td key={i}>{i < awayInn.length ? awayInn[i] : '-'}</td>)}
                                        <td className="pg-scoreboard-totals">{live?.away_score ?? 0}</td>
                                        <td className="pg-scoreboard-totals">{live?.away_hits ?? 0}</td>
                                        <td className="pg-scoreboard-totals">{live?.away_errors ?? 0}</td>
                                      </tr>
                                      <tr>
                                        <td>{g.homeTeam}</td>
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
                                {initials(awayTop?.name)}
                              </span>
                              <Link
                                className="pg-link pg-teamLink"
                                to={toProjections({ date: displayDate, team: g.awayTeam })}
                                style={{ color: awayPalette.primary }}
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
                                style={{ color: homePalette.primary }}
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
                                {initials(homeTop?.name)}
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
                              {homeTop && Object.prototype.hasOwnProperty.call(pickState, homeTop.playerId) ? (
                                <span className={`pg-pickState ${String(pickState[homeTop.playerId] ?? 'pending')}`}>
                                  {pickStatusLabel(pickState[homeTop.playerId])}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                        )}
                      </div>

                      <button
                        type="button"
                        className="pg-expandBtn"
                        onClick={() => setExpandedGameId(isExpanded ? null : g.gameId)}
                      >
                        {isExpanded ? 'Hide details' : 'Expand details'}
                      </button>

                      {isExpanded ? (
                        <div className="pg-detailWrap">
                          <div className="pg-gameRows">
                            <div className="pg-gameLine">
                              <span className="pg-gameLabel">Probable pitchers</span>
                              <span className="pg-gameValue">
                                {g.awayTeam}: {homeTop?.opponentPitcher ? `${homeTop.opponentPitcher}${homeTop.opponentPitcherHand ? ` (${homeTop.opponentPitcherHand})` : ''}` : '—'}
                              </span>
                            </div>
                            <div className="pg-gameLine">
                              <span className="pg-gameLabel"></span>
                              <span className="pg-gameValue">
                                {g.homeTeam}: {awayTop?.opponentPitcher ? `${awayTop.opponentPitcher}${awayTop.opponentPitcherHand ? ` (${awayTop.opponentPitcherHand})` : ''}` : '—'}
                              </span>
                            </div>
                            <p className="pg-small" style={{ marginTop: 10, opacity: 0.88, maxWidth: 520 }}>
                              Missing names here means we did not get a probable starter for that team in{' '}
                              <code>daily_hr_projections</code> (the table-backed path), or the app fell back to
                              the HR model which does not attach starter names yet. Tell us if you want a BallDontLie
                              probable-pitcher field or a separate starters feed wired into projections.
                            </p>
                            {!gameStarted ? (
                              (() => {
                                const awayKey = normalizeTeamCode(g.awayTeam) ?? g.awayTeam
                                const homeKey = normalizeTeamCode(g.homeTeam) ?? g.homeTeam
                                const toTeamKey = (t: string | null | undefined) => normalizeTeamCode(t ?? '') ?? t ?? ''

                                const awayLineup = rows
                                  .filter((p) => toTeamKey(p.team) === awayKey)
                                  .slice()
                                  .sort((a, b) => (b.hrProbability ?? -1) - (a.hrProbability ?? -1))

                                const homeLineup = rows
                                  .filter((p) => toTeamKey(p.team) === homeKey)
                                  .slice()
                                  .sort((a, b) => (b.hrProbability ?? -1) - (a.hrProbability ?? -1))

                                const ordinal = (n: number) => {
                                  if (n === 1) return '1st'
                                  if (n === 2) return '2nd'
                                  if (n === 3) return '3rd'
                                  return `${n}th`
                                }

                                if (!awayLineup.length && !homeLineup.length) {
                                  return <div className="pg-sub">Projected lineup not available for this game.</div>
                                }

                                return (
                                  <>
                                    <div className="pg-lineupGrid">
                                      <div className="pg-lineupTeam">
                                        <div className="pg-lineupTeamTitle">{g.awayTeam}</div>
                                        {awayLineup.map((p, idx) => {
                                          const hasPick = Object.prototype.hasOwnProperty.call(pickState, p.playerId)
                                          return (
                                            <div key={p.playerId} className="pg-lineupRow">
                                              <span className="pg-lineupOrder">{ordinal(idx + 1)}</span>
                                              <span className="pg-lineupPos">{String(p.position ?? '—').toUpperCase()}</span>
                                              <button
                                                type="button"
                                                className="pg-lineupName"
                                                onClick={() => void openMatchup(p)}
                                              >
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
                                      <div className="pg-lineupTeam">
                                        <div className="pg-lineupTeamTitle">{g.homeTeam}</div>
                                        {homeLineup.map((p, idx) => {
                                          const hasPick = Object.prototype.hasOwnProperty.call(pickState, p.playerId)
                                          return (
                                            <div key={p.playerId} className="pg-lineupRow">
                                              <span className="pg-lineupOrder">{ordinal(idx + 1)}</span>
                                              <span className="pg-lineupPos">{String(p.position ?? '—').toUpperCase()}</span>
                                              <button
                                                type="button"
                                                className="pg-lineupName"
                                                onClick={() => void openMatchup(p)}
                                              >
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
                                    </div>
                                  </>
                                )
                              })()
                            ) : null}
                            <div className="pg-gameLine">
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
          <div className="pg-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pg-modalHead">
              <h3>Matchup Comparison</h3>
              <button type="button" className="pg-clearBtn" onClick={() => setMatchupFor(null)}>Close</button>
            </div>
            {matchupLoading ? (
              <p className="pg-sub">Loading matchup...</p>
            ) : (
              <>
                {(() => {
                  const batterGreen = {
                    iso: matchupData?.batter_iso != null && Number(matchupData.batter_iso) >= 0.25,
                    barrel: matchupData?.batter_barrel != null && Number(matchupData.batter_barrel) >= 10,
                    hardHit:
                      matchupData?.batter_hard_hit != null && Number(matchupData.batter_hard_hit) >= 40,
                    avgEv:
                      matchupData?.batter_avg_hit_speed != null &&
                      Number(matchupData.batter_avg_hit_speed) >= 90,
                    fbld:
                      matchupData?.batter_fbld != null && Number(matchupData.batter_fbld) >= 0.45,
                  }
                  const pitcherRed = {
                    hrAllowed:
                      matchupData?.pitcher_hr_allowed != null &&
                      Number(matchupData.pitcher_hr_allowed) >= 20,
                    whip:
                      matchupData?.pitcher_whip != null && Number(matchupData.pitcher_whip) >= 1.3,
                    era:
                      matchupData?.pitcher_era != null && Number(matchupData.pitcher_era) >= 4.5,
                    k9:
                      matchupData?.pitcher_k_per_9 != null && Number(matchupData.pitcher_k_per_9) <= 8,
                  }
                  const pitchRows = Array.isArray(matchupData?.pitch_type_matchup)
                    ? matchupData.pitch_type_matchup
                    : []
                  return (
                    <>
                      <div style={{ marginTop: 10 }}>
                        <div className="pg-label">
                          Power / Contact / Plate skills ({matchupData?.season ?? selectedYear})
                        </div>
                        <div className="pg-matchupGrid">
                          <div>
                            <div className="pg-label" style={{ marginTop: 0 }}>
                              Pitcher
                            </div>
                            <div className="pg-statStack">
                              <div className={`pg-matchStat ${pitcherRed.era ? 'is-green' : ''}`}>
                                ERA: {matchupData?.pitcher_era ?? '—'}
                                <span className={`pg-edgeHint ${pitcherRed.era ? 'is-green' : ''}`}>
                                  Green light: 4.50+
                                </span>
                              </div>
                              <div className={`pg-matchStat ${pitcherRed.whip ? 'is-green' : ''}`}>
                                WHIP: {matchupData?.pitcher_whip ?? '—'}
                                <span className={`pg-edgeHint ${pitcherRed.whip ? 'is-green' : ''}`}>
                                  Green light: 1.30+
                                </span>
                              </div>
                              <div
                                className={`pg-matchStat ${pitcherRed.hrAllowed ? 'is-green' : ''}`}
                              >
                                HR allowed: {matchupData?.pitcher_hr_allowed ?? '—'}
                                <span
                                  className={`pg-edgeHint ${pitcherRed.hrAllowed ? 'is-green' : ''}`}
                                >
                                  Green light: 20+
                                </span>
                              </div>
                              <div className={`pg-matchStat ${pitcherRed.k9 ? 'is-green' : ''}`}>
                                K/9: {matchupData?.pitcher_k_per_9 ?? '—'}
                                <span className={`pg-edgeHint ${pitcherRed.k9 ? 'is-green' : ''}`}>
                                  Green light: 8.0 or lower
                                </span>
                              </div>
                            </div>
                          </div>
                          <div>
                            <div className="pg-label" style={{ marginTop: 0 }}>
                              Batter
                            </div>
                            <div className="pg-statStack">
                              <div className={`pg-matchStat ${batterGreen.iso ? 'is-green' : ''}`}>
                                ISO: {matchupData?.batter_iso ?? '—'}
                                <span className={`pg-edgeHint ${batterGreen.iso ? 'is-green' : ''}`}>
                                  Green light: 0.250+
                                </span>
                              </div>
                              <div
                                className={`pg-matchStat ${batterGreen.barrel ? 'is-green' : ''}`}
                              >
                                Barrel %: {matchupData?.batter_barrel ?? '—'}
                                <span
                                  className={`pg-edgeHint ${batterGreen.barrel ? 'is-green' : ''}`}
                                >
                                  Green light: 10%+
                                </span>
                              </div>
                              <div
                                className={`pg-matchStat ${batterGreen.hardHit ? 'is-green' : ''}`}
                              >
                                Hard-hit %: {matchupData?.batter_hard_hit ?? '—'}
                                <span
                                  className={`pg-edgeHint ${batterGreen.hardHit ? 'is-green' : ''}`}
                                >
                                  Green light: 40%+
                                </span>
                              </div>
                              <div
                                className={`pg-matchStat ${batterGreen.avgEv ? 'is-green' : ''}`}
                              >
                                Avg EV: {matchupData?.batter_avg_hit_speed ?? '—'}
                                <span
                                  className={`pg-edgeHint ${batterGreen.avgEv ? 'is-green' : ''}`}
                                >
                                  Green light: 90+ mph
                                </span>
                              </div>
                              <div
                                className={`pg-matchStat ${batterGreen.fbld ? 'is-green' : ''}`}
                              >
                                FB/LD: {matchupData?.batter_fbld ?? '—'}
                                <span
                                  className={`pg-edgeHint ${batterGreen.fbld ? 'is-green' : ''}`}
                                >
                                  Green light: 0.45+
                                </span>
                              </div>
                              <div className="pg-matchStat">
                                K%:{' '}
                                {matchupData?.batter_k_pct != null
                                  ? `${(Number(matchupData.batter_k_pct) * 100).toFixed(1)}%`
                                  : '—'}
                                <span className="pg-edgeHint">Lower is better</span>
                              </div>
                              <div className="pg-matchStat">
                                BB%:{' '}
                                {matchupData?.batter_bb_pct != null
                                  ? `${(Number(matchupData.batter_bb_pct) * 100).toFixed(1)}%`
                                  : '—'}
                                <span className="pg-edgeHint">Higher is better</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {pitchRows.length ? (
                        <div style={{ marginTop: 10 }}>
                          <div className="pg-label">Pitch-type matchup (pitcher top usage)</div>
                          <div className="pg-pitchTypeGrid">
                            {pitchRows.map((r: any, idx: number) => {
                              const iso = r?.batter_iso != null ? Number(r.batter_iso) : null
                              const usage = r?.usage != null ? Number(r.usage) : null
                              const isoGreen = iso != null && iso >= 0.25
                              const usageBig = usage != null && usage >= 25
                              return (
                                <div key={idx} className="pg-pitchTypeRow">
                                  <div className="pg-pitchTypeTop">
                                    <span>{r?.pitch_name ?? r?.pitch_type ?? 'Pitch'}</span>
                                    <span style={{ color: 'var(--color-muted)', fontWeight: 800 }}>
                                      {usage != null ? `${usage.toFixed(1)}%` : '—'}
                                    </span>
                                  </div>
                                  <div className="pg-pitchTypeMeta">
                                    <span className={`pg-pill ${usageBig ? 'is-green' : ''}`}>
                                      Usage {usage != null ? `${usage.toFixed(1)}%` : '—'}
                                    </span>
                                    <span className={`pg-pill ${isoGreen ? 'is-green' : ''}`}>
                                      Batter ISO {iso != null ? iso.toFixed(3) : '—'}
                                    </span>
                                    <span className="pg-pill">
                                      Pitcher SLG allowed{' '}
                                      {r?.pitcher_slg_allowed != null
                                        ? Number(r.pitcher_slg_allowed).toFixed(3)
                                        : '—'}
                                    </span>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      ) : null}
                    </>
                  )
                })()}

                {matchupData?.pitcher_name ? (
                  <div className="pg-matchupGrid">
                    <div>
                      <div className="pg-label">Pitcher</div>
                      <div className="pg-matchupName">{matchupData.pitcher_name}</div>
                      <div className="pg-small">ERA: {matchupData.pitcher_era ?? '—'} &bull; K: {matchupData.pitcher_k ?? '—'} &bull; WHIP: {matchupData.pitcher_whip ?? '—'}</div>
                    </div>
                    <div>
                      <div className="pg-label">Batter</div>
                      <div className="pg-matchupName">{matchupData.batter_name}</div>
                      <div className="pg-small">HR: {matchupData.batter_season_hr ?? matchupData.batter_hr ?? '—'} &bull; Avg EV: {matchupData.batter_avg_hit_speed ?? '—'} &bull; Barrel: {matchupData.batter_barrel ?? '—'}%</div>
                    </div>
                  </div>
                ) : null}
                {matchupData?.sample_ab ? (
                  <div style={{ marginTop: 10 }}>
                    <div className="pg-label">Batter vs Pitcher</div>
                    <div className="pg-bvpRow">
                      <span className="pg-bvpStat">AB: {matchupData.sample_ab}</span>
                      <span className="pg-bvpStat">H: {matchupData.h ?? 0}</span>
                      <span className="pg-bvpStat">HR: {matchupData.hr ?? 0}</span>
                      <span className="pg-bvpStat">K: {matchupData.k ?? 0}</span>
                      <span className="pg-bvpStat">AVG: {matchupData.avg ?? '—'}</span>
                      <span className="pg-bvpStat">OPS: {matchupData.ops ?? '—'}</span>
                    </div>
                  </div>
                ) : null}
                <div style={{ marginTop: 10 }}>
                  <div className="pg-label">
                    Pitcher vs Batter (advantage by stat) ({matchupData?.season ?? playerInputs?.season ?? selectedYear})
                  </div>
                  <div className="pg-matchupGrid">
                    <div>
                      <div className="pg-label" style={{ marginTop: 0 }}>Pitcher</div>
                      <div className="pg-statStack">
                        <div className="pg-matchStat">
                          ERA: {matchupData?.pitcher_era ?? '—'}
                          <span className="pg-edgeHint">Advantage: Pitcher (lower)</span>
                        </div>
                        <div className="pg-matchStat">
                          K: {matchupData?.pitcher_k ?? '—'}
                          <span className="pg-edgeHint">Advantage: Pitcher (higher)</span>
                        </div>
                        <div className="pg-matchStat">
                          WHIP: {matchupData?.pitcher_whip ?? '—'}
                          <span className="pg-edgeHint">Advantage: Pitcher (lower)</span>
                        </div>
                        <div className="pg-matchStat">
                          HR allowed: {matchupData?.pitcher_hr_allowed ?? '—'}
                          <span className="pg-edgeHint">Advantage: Pitcher (lower)</span>
                        </div>
                      </div>
                    </div>
                    <div>
                      <div className="pg-label" style={{ marginTop: 0 }}>Batter</div>
                      <div className="pg-statStack">
                        <div className="pg-matchStat">
                          EV95: {matchupData?.batter_ev95 ?? playerInputs?.ev95percent ?? '—'}
                          <span className="pg-edgeHint">Advantage: Batter (higher)</span>
                        </div>
                        <div className="pg-matchStat">
                          Barrel %: {matchupData?.batter_barrel ?? playerInputs?.brl_percent ?? '—'}
                          <span className="pg-edgeHint">Advantage: Batter (higher)</span>
                        </div>
                        <div className="pg-matchStat">
                          Avg EV: {matchupData?.batter_avg_hit_speed ?? playerInputs?.avg_hit_speed ?? '—'}
                          <span className="pg-edgeHint">Advantage: Batter (higher)</span>
                        </div>
                        <div className="pg-matchStat">
                          FB/LD: {matchupData?.batter_fbld ?? playerInputs?.fbld ?? '—'}
                          <span className="pg-edgeHint">Advantage: Batter (higher)</span>
                        </div>
                        <div className="pg-matchStat">
                          HR Total: {matchupData?.batter_hr ?? playerInputs?.hr_total ?? '—'}
                          <span className="pg-edgeHint">Advantage: Batter (higher)</span>
                        </div>
                        <div className="pg-matchStat">
                          Attempts: {matchupData?.batter_attempts ?? playerInputs?.attempts ?? '—'}
                          <span className="pg-edgeHint">Advantage: Batter (more PAs)</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                {!matchupData && !playerInputs ? (
                  <p className="pg-sub">No data found for this player/season. Try selecting a different year.</p>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
