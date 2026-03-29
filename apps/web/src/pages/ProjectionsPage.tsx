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
import { bdlRowMatchesCalendarDay } from '../utils/bdlCalendarDay'

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

function sportsbookLabel(vendor: string): string {
  if (!vendor) return 'Sportsbook'
  if (vendor === 'betmgm') return 'BetMGM'
  if (vendor === 'betrivers') return 'BetRivers'
  return vendor.charAt(0).toUpperCase() + vendor.slice(1)
}

function formatBookOdds(odds: number | null | undefined): string | null {
  if (odds == null || !Number.isFinite(odds)) return null
  return odds > 0 ? `+${odds}` : String(odds)
}

const SUPPORTED_SPORTSBOOKS = ['caesars', 'betmgm', 'betrivers'] as const

function normalizeSportsbook(value: string | null | undefined): string {
  const raw = String(value ?? '').toLowerCase().trim()
  return SUPPORTED_SPORTSBOOKS.includes(raw as (typeof SUPPORTED_SPORTSBOOKS)[number]) ? raw : 'caesars'
}

function chooseBestPlayerBook(
  props: Array<{ vendor: string | null; line_value: string | null; milestone_odds: number | null; over_odds: number | null }>,
  preferredVendor: string,
): { odds: number; vendor: string } | null {
  const rankedVendors = [preferredVendor, ...SUPPORTED_SPORTSBOOKS.filter((v) => v !== preferredVendor)]
  const bestByVendor = new Map<string, { odds: number; vendor: string; lineValue: number | null }>()
  for (const p of props) {
    const vendor = normalizeSportsbook(p.vendor)
    const odds = p.milestone_odds ?? p.over_odds ?? null
    if (odds == null) continue
    const lineValue = Number(p.line_value ?? '')
    const normalizedLine = Number.isFinite(lineValue) ? lineValue : null
    const prev = bestByVendor.get(vendor)
    const shouldReplace =
      !prev ||
      (normalizedLine === 0.5 && prev.lineValue !== 0.5) ||
      (
        normalizedLine != null &&
        prev.lineValue != null &&
        normalizedLine < prev.lineValue &&
        prev.lineValue !== 0.5
      )
    if (shouldReplace) {
      bestByVendor.set(vendor, { odds: Number(odds), vendor, lineValue: normalizedLine })
    }
  }
  for (const vendor of rankedVendors) {
    const hit = bestByVendor.get(vendor)
    if (hit) return { odds: hit.odds, vendor: hit.vendor }
  }
  return null
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
  const [probablePitchers, setProbablePitchers] = useState<Record<string, { home: string | null; away: string | null }>>({})
  const [playerOdds, setPlayerOdds] = useState<Record<string, { odds: number; vendor: string } | null>>({})
  const [defaultSportsbook, setDefaultSportsbook] = useState<string>('caesars')
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
      setDisplayDate((d) => {
        if (dates.includes(d)) return d
        const today = getAppDisplayDateIso()
        if (dates.includes(today)) return today
        return dates[dates.length - 1] ?? d
      })
    })
  }, [supabase])

  useEffect(() => {
    if (!supabase || !session?.user.id) return
    void supabase
      .from('user_settings')
      .select('default_sportsbook')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.default_sportsbook) setDefaultSportsbook(normalizeSportsbook(String(data.default_sportsbook)))
      })
  }, [supabase, session?.user.id])

  useEffect(() => {
    if (!supabase) return
    setLoading(true)
    const prevDate = new Date(`${displayDate}T12:00:00Z`)
    prevDate.setUTCDate(prevDate.getUTCDate() - 1)
    const nextDate = new Date(`${displayDate}T12:00:00Z`)
    nextDate.setUTCDate(nextDate.getUTCDate() + 1)
    const prevIso = prevDate.toISOString().slice(0, 10)
    const nextIso = nextDate.toISOString().slice(0, 10)
    void Promise.all([
      listDailyHrProjections(supabase, displayDate),
      getGamesForDate(supabase, displayDate),
      supabase
        .from('bdl_games')
        .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev,status')
        .gte('date', prevIso)
        .lte('date', nextIso),
    ])
      .then(([proj, sched, live]) => {
        setRows(proj)
        setGames(sched)
        const raw = (live.data ?? []) as any[]
        const dayIso = displayDate
        setLiveGames(raw.filter((lg) => bdlRowMatchesCalendarDay(lg, dayIso)))
      })
      .finally(() => setLoading(false))
  }, [supabase, displayDate])

  useEffect(() => {
    if (!supabase) return
    const id = setInterval(() => {
      const prevDate = new Date(`${displayDate}T12:00:00Z`)
      prevDate.setUTCDate(prevDate.getUTCDate() - 1)
      const nextDate = new Date(`${displayDate}T12:00:00Z`)
      nextDate.setUTCDate(nextDate.getUTCDate() + 1)
      const prevIso = prevDate.toISOString().slice(0, 10)
      const nextIso = nextDate.toISOString().slice(0, 10)
      void supabase
        .from('bdl_games')
        .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev,status')
        .gte('date', prevIso)
        .lte('date', nextIso)
        .then(({ data }) => {
          const raw = (data ?? []) as any[]
          const dayIso = displayDate
          setLiveGames(raw.filter((lg) => bdlRowMatchesCalendarDay(lg, dayIso)))
        })
    }, 60000)
    return () => clearInterval(id)
  }, [displayDate, supabase])

  useEffect(() => {
    const base = import.meta.env.VITE_API_BASE_URL ?? ''
    if (!base) return
    void fetch(`${base}/bdl/probable-pitchers?date=${displayDate}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: Record<string, { home: string | null; away: string | null }> } | null) => {
        setProbablePitchers(json?.data ?? {})
      })
      .catch(() => {})
  }, [displayDate])


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

  useEffect(() => {
    if (!supabase || !games.length || !filteredRows.length) {
      setPlayerOdds({})
      return
    }
    const bdlGameIds = games
      .map((g) => Number(g.gameId))
      .filter((id) => Number.isFinite(id) && id > 0)
    const statIds = [...new Set(filteredRows.map((r) => r.playerId).filter(Boolean))]
    if (!bdlGameIds.length || !statIds.length) {
      setPlayerOdds({})
      return
    }

    void (async () => {
      const { data: xref } = await supabase
        .from('bdl_players')
        .select('bdl_id,stat_player_id')
        .in('stat_player_id', statIds.slice(0, 400))
      const statToBdl = new Map<string, number>(
        (xref ?? []).map((r: any) => [String(r.stat_player_id), Number(r.bdl_id)]),
      )
      const bdlPlayerIds = [...statToBdl.values()].filter(Boolean)
      if (!bdlPlayerIds.length) {
        setPlayerOdds({})
        return
      }

      const { data: props } = await supabase
        .from('bdl_player_props')
        .select('bdl_player_id,line_value,milestone_odds,over_odds,vendor')
        .in('bdl_game_id', bdlGameIds)
        .in('bdl_player_id', bdlPlayerIds)
        .eq('prop_type', 'home_runs')

      if (!props?.length) {
        setPlayerOdds({})
        return
      }

      const bdlToStat = new Map<number, string>()
      for (const [sid, bid] of statToBdl) bdlToStat.set(bid, sid)

      const next: Record<string, { odds: number; vendor: string } | null> = {}
      const propsByStat = new Map<string, Array<{ vendor: string | null; line_value: string | null; milestone_odds: number | null; over_odds: number | null }>>()
      for (const p of props as any[]) {
        const sid = bdlToStat.get(Number(p.bdl_player_id))
        if (!sid) continue
        if (!propsByStat.has(sid)) propsByStat.set(sid, [])
        propsByStat.get(sid)!.push(p)
      }
      for (const [sid, statProps] of propsByStat) {
        const best = chooseBestPlayerBook(statProps, defaultSportsbook)
        if (best) next[sid] = best
      }
      setPlayerOdds(next)
    })()
  }, [defaultSportsbook, filteredRows, games, supabase])

  const selectedPlayer = useMemo(
    () => rows.find((r) => r.playerId === selectedPlayerId) ?? null,
    [rows, selectedPlayerId],
  )

  const probablePitcherByMatchup = useMemo(() => {
    const out = new Map<string, { name: string | null; hand: string | null }>()
    for (const game of games) {
      const home = (normalizeTeamCode(game.homeTeam) ?? game.homeTeam).toUpperCase()
      const away = (normalizeTeamCode(game.awayTeam) ?? game.awayTeam).toUpperCase()
      const pp = probablePitchers[String(game.gameId)]
      if (!pp) continue
      out.set(`${home}|${away}`, { name: pp.away ?? null, hand: null })
      out.set(`${away}|${home}`, { name: pp.home ?? null, hand: null })
    }
    return out
  }, [games, probablePitchers])

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

  function displayOpponentPitcher(r: DailyProjection): { name: string | null; hand: string | null } {
    if (r.opponentPitcher) return { name: r.opponentPitcher, hand: r.opponentPitcherHand ?? null }
    const team = (normalizeTeamCode(r.team ?? '') ?? '').toUpperCase()
    const opp = (parseOpponentTeam(r) ?? '').toUpperCase()
    if (!team || !opp) return { name: null, hand: null }
    return probablePitcherByMatchup.get(`${team}|${opp}`) ?? { name: null, hand: null }
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
              {s.data.map((r) => {
                const displayPitcher = displayOpponentPitcher(r)
                const bookOdds = formatBookOdds(playerOdds[r.playerId]?.odds)
                const bookVendor = playerOdds[r.playerId]?.vendor ?? defaultSportsbook
                return (
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
                    {displayPitcher.name ? (
                      <span className="pg-matchup">
                        vs {displayPitcher.name}{' '}
                        {displayPitcher.hand ? `(${displayPitcher.hand})` : ''}
                      </span>
                    ) : null}
                  </div>
                  <div className="pg-right">
                    <span className="pg-prob">{formatProbability(r.hrProbability)}</span>
                    <span
                      className="pg-odds"
                      style={{ color: tierColor(r.tier ?? 'D') }}
                      title={bookOdds ? `${sportsbookLabel(bookVendor)} HR odds` : 'Sportsbook HR odds unavailable'}
                    >
                      {bookOdds ?? '—'}
                    </span>
                    {bookOdds ? (
                      <span className="pg-small">{sportsbookLabel(bookVendor)}</span>
                    ) : null}
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
                )
              })}
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
                                K%: {matchupData?.batter_k_pct != null ? `${(Number(matchupData.batter_k_pct) * 100).toFixed(1)}%` : '—'}
                                <span className="pg-edgeHint">Lower is better</span>
                              </div>
                              <div className="pg-matchStat">
                                BB%: {matchupData?.batter_bb_pct != null ? `${(Number(matchupData.batter_bb_pct) * 100).toFixed(1)}%` : '—'}
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
