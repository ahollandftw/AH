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

  useEffect(() => {
    if (!supabase) return
    void getScheduleDates(supabase).then((dates) => {
      if (!dates.length) return
      setAvailableDates(dates)
      if (!dates.includes(displayDate)) setDisplayDate(dates[0])
    })
  }, [supabase, displayDate])

  useEffect(() => {
    if (!supabase) return
    setLoading(true)
    void Promise.all([
      listDailyHrProjections(supabase, displayDate),
      getGamesForDate(supabase, displayDate),
      supabase
        .from('bdl_games')
        .select('bdl_game_id,start_time_utc,home_team_abbrev,away_team_abbrev,status,home_score,away_score,home_hits,away_hits,home_errors,away_errors,scoring_summary')
        .eq('date', displayDate),
    ])
      .then(([proj, sched, live]) => {
        setRows(proj)
        setGames(sched)
        setLiveGames((live.data ?? []) as any[])
      })
      .finally(() => setLoading(false))
  }, [supabase, displayDate])

  useEffect(() => {
    if (!supabase) return
    const id = setInterval(() => {
      void supabase
        .from('bdl_games')
        .select('bdl_game_id,start_time_utc,home_team_abbrev,away_team_abbrev,status,home_score,away_score,home_hits,away_hits,home_errors,away_errors,scoring_summary')
        .eq('date', displayDate)
        .then(({ data }) => setLiveGames((data ?? []) as any[]))
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
    const byPair = new Map<string, any>()
    for (const g of liveGames) {
      byPair.set(pairKey(g.home_team_abbrev, g.away_team_abbrev), g)
    }
    const sorted = [...games].sort((a, b) => {
      const ga = byPair.get(pairKey(a.homeTeam, a.awayTeam))
      const gb = byPair.get(pairKey(b.homeTeam, b.awayTeam))
      const ta = ga?.start_time_utc ? new Date(ga.start_time_utc).getTime() : Number.MAX_SAFE_INTEGER
      const tb = gb?.start_time_utc ? new Date(gb.start_time_utc).getTime() : Number.MAX_SAFE_INTEGER
      return ta - tb
    })
    if (hasSubscription || sorted.length <= 1) return sorted
    const idx =
      displayDate.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % sorted.length
    return [sorted[idx]]
  }, [displayDate, games, hasSubscription, liveGames])

  function toProjections(params: { date: string; team?: string; player?: string }) {
    const qp = new URLSearchParams()
    qp.set('date', params.date)
    if (params.team) qp.set('team', params.team)
    if (params.player) qp.set('player', params.player)
    return `/projections?${qp.toString()}`
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
      setPlayerInputs({
        avg_hit_speed: evRes?.data?.avg_hit_speed ?? null,
        ev95percent: evRes?.data?.ev95percent ?? null,
        brl_percent: evRes?.data?.brl_percent ?? null,
        fbld: evRes?.data?.fbld ?? null,
        attempts: evRes?.data?.attempts ?? null,
        hr_total: hrRes?.data?.hr_total ?? null,
        season: evRes?.data?.season ?? hrRes?.data?.year ?? null,
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
                  const live = liveGames.find((lg) => [normalizeTeamCode(lg.home_team_abbrev) ?? lg.home_team_abbrev, normalizeTeamCode(lg.away_team_abbrev) ?? lg.away_team_abbrev].sort().join('|') === pairKey) ?? null
                  const status = String(live?.status ?? '').toLowerCase()
                  const gameStarted = !!live && !/scheduled|pre|not started/.test(status)
                  const awayKey = normalizeTeamCode(g.awayTeam) ?? g.awayTeam
                  const homeKey = normalizeTeamCode(g.homeTeam) ?? g.homeTeam
                  const awayTop = topByTeam.get(awayKey)
                  const homeTop = topByTeam.get(homeKey)
                  const awayPalette = paletteForTeam(awayTop?.team ?? g.awayTeam)
                  const homePalette = paletteForTeam(homeTop?.team ?? g.homeTeam)
                  const isExpanded = expandedGameId === g.gameId
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
                            {live?.start_time_utc
                              ? `${new Date(live.start_time_utc).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} • ${live.status ?? 'Scheduled'}`
                              : 'Start time: —'}
                          </div>
                        </div>
                        {gameStarted ? (
                          <div className="pg-gameRows">
                            <div className="pg-gameLine">
                              <span className="pg-gameLabel">Scoreboard (R / H / E)</span>
                              <span className="pg-gameValue" style={{ textAlign: 'left' }}>
                                {g.awayTeam}: {live?.away_score ?? 0} / {live?.away_hits ?? 0} / {live?.away_errors ?? 0}
                                <br />
                                {g.homeTeam}: {live?.home_score ?? 0} / {live?.home_hits ?? 0} / {live?.home_errors ?? 0}
                              </span>
                            </div>
                            <div className="pg-gameLine">
                              <span className="pg-gameLabel">Scoring plays</span>
                              <span className="pg-gameValue" style={{ textAlign: 'left' }}>
                                {(Array.isArray(live?.scoring_summary) ? live.scoring_summary : []).length === 0
                                  ? 'No scoring plays listed yet.'
                                  : (live.scoring_summary as any[])
                                      .map((p: any) => {
                                        const txt = String(p?.play ?? '')
                                        const hr = /home run|homer|grand slam/i.test(txt)
                                        return `${hr ? '🏠⚾' : '⚾'} ${txt} (${p?.inning ?? ''})`
                                      })
                                      .slice(-6)
                                      .join(' | ')}
                              </span>
                            </div>
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
                              <span className="pg-gameLabel">Starting pitchers</span>
                              <span className="pg-gameValue">
                                {g.awayTeam}: {homeTop?.opponentPitcher ?? '—'} &nbsp;|&nbsp; {g.homeTeam}: {awayTop?.opponentPitcher ?? '—'}
                              </span>
                            </div>
                            <div className="pg-gameLine">
                              <span className="pg-gameLabel">Highest edge</span>
                              <span className="pg-gameValue">
                                {g.awayTeam}: — &nbsp;|&nbsp; {g.homeTeam}: —
                              </span>
                            </div>
                            <div className="pg-gameLine">
                              <span className="pg-gameLabel">Open projections</span>
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
                      <div className="pg-small">HR: {matchupData.batter_hr ?? '—'} &bull; Avg EV: {matchupData.batter_avg_hit_speed ?? '—'} &bull; Barrel: {matchupData.batter_barrel ?? '—'}%</div>
                    </div>
                  </div>
                ) : null}
                {matchupData?.sample_ab ? (
                  <div style={{ marginTop: 10 }}>
                    <div className="pg-label">Batter vs Pitcher</div>
                    <div className="pg-matchupGrid">
                      <div className="pg-matchStat">AB: {matchupData.sample_ab}</div>
                      <div className="pg-matchStat">H: {matchupData.h ?? 0}</div>
                      <div className="pg-matchStat">HR: {matchupData.hr ?? 0}</div>
                      <div className="pg-matchStat">K: {matchupData.k ?? 0}</div>
                      <div className="pg-matchStat">AVG: {matchupData.avg ?? '—'}</div>
                      <div className="pg-matchStat">OPS: {matchupData.ops ?? '—'}</div>
                    </div>
                  </div>
                ) : null}
                <div style={{ marginTop: 10 }}>
                  <div className="pg-label">Statcast / Projection Inputs ({matchupData?.season ?? playerInputs?.season ?? selectedYear})</div>
                  <div className="pg-matchupGrid">
                    <div className="pg-matchStat">Hard Hit / EV95: {matchupData?.batter_ev95 ?? playerInputs?.ev95percent ?? '—'}</div>
                    <div className="pg-matchStat">Barrel %: {matchupData?.batter_barrel ?? playerInputs?.brl_percent ?? '—'}</div>
                    <div className="pg-matchStat">Avg EV: {matchupData?.batter_avg_hit_speed ?? playerInputs?.avg_hit_speed ?? '—'}</div>
                    <div className="pg-matchStat">FB/LD: {matchupData?.batter_fbld ?? playerInputs?.fbld ?? '—'}</div>
                    <div className="pg-matchStat">HR Total: {matchupData?.batter_hr ?? playerInputs?.hr_total ?? '—'}</div>
                    <div className="pg-matchStat">Batted Ball Attempts: {matchupData?.batter_attempts ?? playerInputs?.attempts ?? '—'}</div>
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
