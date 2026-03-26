import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  formatProbability,
  getAppDisplayDateIso,
  getGamesForDate,
  getScheduleDates,
  groupProjectionsByTier,
  listDailyHrProjections,
  type DailyProjection,
  type ScheduleGame,
} from '@kinetic/shared'
import { useWebAuth } from '../auth/WebAuthProvider.tsx'
import { normalizeTeamCode } from '../theme/teamPalette'

function tierColor(k: string): string {
  switch (k) {
    case 'A+': return '#ffdf00'
    case 'A':  return '#00e639'
    case 'B':  return '#adc8f5'
    case 'C':  return '#8f9097'
    case 'D':  return '#44474d'
    default:   return '#44474d'
  }
}

function tierBadgeBg(k: string): string {
  switch (k) {
    case 'A+': return 'rgba(255,223,0,0.15)'
    case 'A':  return 'rgba(0,230,57,0.12)'
    case 'B':  return 'rgba(173,200,245,0.12)'
    case 'C':  return 'rgba(143,144,151,0.10)'
    case 'D':  return 'rgba(68,71,77,0.10)'
    default:   return 'transparent'
  }
}

export default function ProjectionsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { supabase, hasSubscription, session } = useWebAuth()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<DailyProjection[]>([])
  const [games, setGames] = useState<ScheduleGame[]>([])
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [pickState, setPickState] = useState<Record<string, boolean | null>>({})
  const [pickBusy, setPickBusy] = useState<string | null>(null)
  const [pickMsg, setPickMsg] = useState('')
  const [matchupLoading, setMatchupLoading] = useState(false)
  const [matchupFor, setMatchupFor] = useState<DailyProjection | null>(null)
  const [matchupData, setMatchupData] = useState<any>(null)
  const [playerInputs, setPlayerInputs] = useState<any>(null)
  const [selectedYear, setSelectedYear] = useState<number>(2026)
  const [liveGames, setLiveGames] = useState<any[]>([])
  const [displayDate, setDisplayDate] = useState(
    searchParams.get('date') ?? getAppDisplayDateIso(),
  )
  const selectedTeam = (normalizeTeamCode(searchParams.get('team') ?? '') ?? '').toUpperCase()
  const selectedPlayerId = searchParams.get('player') ?? ''

  useEffect(() => {
    const qDate = searchParams.get('date')
    if (qDate && qDate !== displayDate) setDisplayDate(qDate)
  }, [displayDate, searchParams])

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
        .select('home_team_abbrev,away_team_abbrev,status')
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
        .select('home_team_abbrev,away_team_abbrev,status')
        .eq('date', displayDate)
        .then(({ data }) => setLiveGames((data ?? []) as any[]))
    }, 60000)
    return () => clearInterval(id)
  }, [displayDate, supabase])

  const filteredRows = useMemo(() => {
    let out = rows
    if (!hasSubscription && games.length > 0) {
      const idx =
        displayDate.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % games.length
      const g = games[idx]
      const allowed = new Set([g.awayTeam, g.homeTeam])
      out = out.filter((r) => r.team && allowed.has(r.team))
    }
    if (selectedTeam) out = out.filter((r) => (normalizeTeamCode(r.team ?? '') ?? '').toUpperCase() === selectedTeam)
    if (selectedPlayerId) out = out.filter((r) => r.playerId === selectedPlayerId)
    return out
  }, [displayDate, games, hasSubscription, rows, selectedPlayerId, selectedTeam])

  const selectedPlayer = useMemo(
    () => rows.find((r) => r.playerId === selectedPlayerId) ?? null,
    [rows, selectedPlayerId],
  )

  const sections = useMemo(
    () =>
      groupProjectionsByTier(filteredRows).map((g) => ({
        key: g.tierKey,
        label: g.tierLabel.toUpperCase(),
        data: g.data,
      })),
    [filteredRows],
  )

  const selectedCount = useMemo(
    () => Object.keys(pickState).length,
    [pickState],
  )

  function parseOpponentTeam(r: DailyProjection): string | null {
    const txt = (r.opponent ?? '').trim()
    if (!txt) return null
    const m = txt.match(/(?:vs|@)\s+([A-Za-z]{2,4})/i)
    return normalizeTeamCode(m?.[1] ?? '')?.toUpperCase() ?? null
  }

  function pickStatusLabel(v: boolean | null | undefined): string {
    if (v === true) return 'HIT'
    if (v === false) return 'MISS'
    if (v === null) return 'PENDING'
    return ''
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

  async function togglePick(playerId: string) {
    if (!supabase || !session?.user.id) {
      setPickMsg('Sign in to use targets.')
      return
    }
    const player = rows.find((r) => r.playerId === playerId)
    const playerTeam = normalizeTeamCode(player?.team ?? '')
    const locked = liveGames.some((g) => {
      const a = normalizeTeamCode(g.away_team_abbrev ?? '')
      const h = normalizeTeamCode(g.home_team_abbrev ?? '')
      const status = String(g.status ?? '').toLowerCase()
      const started = !/scheduled|pre|not started/.test(status)
      return started && (playerTeam === a || playerTeam === h)
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

    const count = Object.keys(pickState).length
    if (count >= 3) {
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

  async function openMatchup(r: DailyProjection) {
    setMatchupFor(r)
    setMatchupData(null)
    setPlayerInputs(null)
    const opponentTeam = parseOpponentTeam(r)
    if (!opponentTeam) return
    setMatchupLoading(true)
    try {
      const base = import.meta.env.VITE_API_BASE_URL ?? ''
      const [matchupRes, evRes, hrRes] = await Promise.all([
        fetch(
          `${base}/bdl/matchup-card?player_id=${encodeURIComponent(r.playerId)}&opponent_team=${encodeURIComponent(opponentTeam)}&season=${selectedYear}${r.opponentPitcher ? `&pitcher_name=${encodeURIComponent(r.opponentPitcher)}` : ''}`,
        ),
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

  return (
    <div className="pg">
      <h1 className="pg-title">Projections</h1>
      <div className="pg-controls">
        <label htmlFor="proj-date" className="pg-label">
          Date
        </label>
        <input
          id="proj-date"
          className="pg-date"
          type="date"
          value={displayDate}
          min={availableDates[0]}
          max={availableDates[availableDates.length - 1]}
          onChange={(e) => {
            const nextDate = e.target.value
            setDisplayDate(nextDate)
            const next = new URLSearchParams(searchParams)
            next.set('date', nextDate)
            setSearchParams(next, { replace: true })
          }}
        />
        <label htmlFor="proj-year" className="pg-label">Year</label>
        <select
          id="proj-year"
          className="acc-select"
          value={selectedYear}
          onChange={(e) => setSelectedYear(Number(e.target.value))}
        >
          {[2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019].map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        {(selectedTeam || selectedPlayerId) && (
          <button
            type="button"
            className="pg-clearBtn"
            onClick={() => {
              const next = new URLSearchParams(searchParams)
              next.delete('team')
              next.delete('player')
              setSearchParams(next, { replace: true })
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      <p className="pg-sub">
        {displayDate} &mdash; {games.length} game{games.length !== 1 ? 's' : ''} &mdash;{' '}
        {filteredRows.length && filteredRows[0]?.source === 'hr_model'
          ? 'Matchup-based HR model — grouped by tier.'
          : 'Daily launch — grouped by tier.'}
      </p>
      {!hasSubscription ? (
        <p className="pg-sub">Free preview: one random game. Subscribe to unlock full projections.</p>
      ) : null}
      {session ? (
        <p className="pg-sub">Targets used: {selectedCount}/3 {pickMsg ? `— ${pickMsg}` : ''}</p>
      ) : (
        <p className="pg-sub">Sign in to select up to 3 daily targets.</p>
      )}
      {(selectedTeam || selectedPlayer) && (
        <div className="pg-focusCard">
          {selectedTeam ? <div className="pg-focusLine">Team filter: {selectedTeam}</div> : null}
          {selectedPlayer ? (
            <div className="pg-focusLine">
              Matchup: {selectedPlayer.name} ({selectedPlayer.team ?? '—'}){' '}
              {selectedPlayer.opponent ?? 'matchup pending'}
            </div>
          ) : null}
        </div>
      )}
      {loading ? (
        <div className="lb-skel">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="lb-skelRow" />
          ))}
        </div>
      ) : sections.length === 0 ? (
        <p className="pg-empty">No games scheduled or projection data for {displayDate}.</p>
      ) : (
        sections.map((s) => (
          <div key={s.key} style={{ marginBottom: 24 }}>
            <div
              className="pg-tier"
              style={{ borderLeftColor: tierColor(s.key), color: tierColor(s.key) }}
            >
              {s.label}
            </div>
            <div className="pg-cards">
              {s.data.map((r) => (
                <div
                  key={r.playerId}
                  className="pg-card"
                  onClick={() => void openMatchup(r)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      void openMatchup(r)
                    }
                  }}
                >
                  <div className="pg-info">
                    <div className="pg-nameRow">
                      <button
                        type="button"
                        className={`pg-targetBtn ${Object.prototype.hasOwnProperty.call(pickState, r.playerId) ? 'is-selected' : ''}`}
                        title="Toggle target pick"
                        disabled={pickBusy === r.playerId}
                        onClick={(e) => {
                          e.stopPropagation()
                          void togglePick(r.playerId)
                        }}
                      >
                        🎯
                      </button>
                      <button
                        type="button"
                        className="pg-playerSelect"
                        onClick={(e) => {
                          e.stopPropagation()
                          void openMatchup(r)
                        }}
                      >
                        {r.name}
                      </button>
                    </div>
                    <span className="pg-meta">
                      {(r.team ?? '—').toUpperCase()} &bull; {(r.position ?? '—').toUpperCase()}
                    </span>
                    {r.opponent ? (
                      <span className="pg-matchup">{r.opponent}</span>
                    ) : null}
                    {r.opponentPitcher ? (
                      <span className="pg-matchup">
                        vs {r.opponentPitcher}{' '}
                        {r.opponentPitcherHand ? `(${r.opponentPitcherHand})` : ''}
                      </span>
                    ) : null}
                  </div>
                  <div className="pg-right">
                    <span className="pg-prob">{formatProbability(r.hrProbability)}</span>
                    <span
                      className="pg-odds"
                      style={{ color: tierColor(r.tier ?? 'D') }}
                    >
                      {r.americanOddsStr ?? '—'}
                    </span>
                    <span
                      className="pg-tierBadge"
                      style={{
                        color: tierColor(r.tier ?? 'D'),
                        background: tierBadgeBg(r.tier ?? 'D'),
                      }}
                    >
                      {r.tier ?? '—'}
                    </span>
                    {r.l7Hrs != null ? (
                      <span className="pg-small">L7 HRs: {r.l7Hrs}</span>
                    ) : null}
                    {Object.prototype.hasOwnProperty.call(pickState, r.playerId) ? (
                      <span className={`pg-pickState ${String(pickState[r.playerId] ?? 'pending')}`}>
                        {pickStatusLabel(pickState[r.playerId])}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
      {matchupFor ? (
        <div className="pg-modalBackdrop" onClick={() => setMatchupFor(null)}>
          <div className="pg-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pg-modalHead">
              <h3>Matchup Comparison</h3>
              <button type="button" className="pg-clearBtn" onClick={() => setMatchupFor(null)}>Close</button>
            </div>
            <p className="pg-sub">{matchupFor.name} {matchupFor.opponent ?? ''}</p>
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
