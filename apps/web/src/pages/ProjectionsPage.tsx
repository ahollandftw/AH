import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  formatProbability,
  getAppDisplayDateIso,
  getGamesForDate,
  getScheduleDates,
  groupProjectionsByTier,
  listDailyHrProjectionsAllModels,
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
  if (vendor === 'draftkings') return 'DraftKings'
  if (vendor === 'fanduel') return 'FanDuel'
  if (vendor === 'fanatics') return 'Fanatics'
  if (vendor === 'betmgm') return 'BetMGM'
  if (vendor === 'betrivers') return 'BetRivers'
  return vendor.charAt(0).toUpperCase() + vendor.slice(1)
}

function formatBookOdds(odds: number | null | undefined): string | null {
  if (odds == null || !Number.isFinite(odds)) return null
  return odds > 0 ? `+${odds}` : String(odds)
}

const SUPPORTED_SPORTSBOOKS = ['draftkings', 'fanduel', 'fanatics', 'caesars', 'betmgm', 'betrivers'] as const

function normalizeSportsbook(value: string | null | undefined): string {
  const raw = String(value ?? '').toLowerCase().trim()
  return SUPPORTED_SPORTSBOOKS.includes(raw as (typeof SUPPORTED_SPORTSBOOKS)[number]) ? raw : 'draftkings'
}

type PlayerBookOdds = {
  bestOdds: number
  bestVendor: string
  all: Array<{ vendor: string; odds: number }>
}

type TeamPitcherInfo = {
  bdl_player_id: number | null
  stat_player_id: string | null
  full_name: string | null
  position: string | null
}

type LineupPlayer = {
  bdl_player_id: number | null
  stat_player_id: string | null
  full_name: string | null
  position: string | null
  batting_order: number | null
}

type GameLineup = {
  home: LineupPlayer[]
  away: LineupPlayer[]
  home_pitcher?: TeamPitcherInfo | null
  away_pitcher?: TeamPitcherInfo | null
  home_source?: 'official' | 'previous_game' | 'none'
  away_source?: 'official' | 'previous_game' | 'none'
}

type MatchupPitchRow = {
  pitch_type: string | null
  pitch_name: string | null
  usage: number | null
  season?: number | null
  batter_iso: number | null
  batter_slg: number | null
  batter_ba: number | null
  batter_woba: number | null
  batter_est_slg: number | null
  batter_est_woba: number | null
  batter_k_percent: number | null
  batter_hard_hit_percent: number | null
  pitcher_slg_allowed: number | null
  pitcher_ba_allowed: number | null
  pitcher_woba_allowed: number | null
  pitcher_est_slg_allowed: number | null
  pitcher_est_woba_allowed: number | null
  pitcher_hard_hit_percent: number | null
}

function oddsProfitScore(odds: number): number {
  if (odds >= 0) return odds
  return 10000 / Math.abs(odds)
}

function normalizePlayerName(name: string | null | undefined): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatMetric(value: number | null | undefined, digits = 3): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return Number(value).toFixed(digits)
}

function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Number(value).toFixed(digits)}%`
}

/** Quick letter grade for batter ISO vs pitcher SLG allowed on this pitch. */
function arsenalPitchGrade(row: MatchupPitchRow): string {
  const iso = row.batter_iso != null ? Number(row.batter_iso) : null
  const slg = row.pitcher_slg_allowed != null ? Number(row.pitcher_slg_allowed) : null
  let score = 0
  let n = 0
  if (iso != null && Number.isFinite(iso)) {
    score += Math.min(1.2, Math.max(0, iso / 0.35)) * 50
    n += 1
  }
  if (slg != null && Number.isFinite(slg)) {
    score += Math.min(1.2, Math.max(0, (slg - 0.35) / 0.25)) * 50
    n += 1
  }
  if (n === 0) return '—'
  const avg = score / n
  if (avg >= 85) return 'A'
  if (avg >= 70) return 'B'
  if (avg >= 55) return 'C'
  if (avg >= 40) return 'D'
  return 'F'
}

function extractHomerHitters(scoringSummary: any): Set<string> {
  const out = new Set<string>()
  const plays = Array.isArray(scoringSummary) ? scoringSummary : []
  for (const p of plays) {
    const txt = String(p?.play ?? '').trim()
    if (!/home run|homer|grand slam/i.test(txt)) continue
    const beforeHomered = txt.split(/\bhomered\b/i)[0]?.trim()
    if (beforeHomered) out.add(normalizePlayerName(beforeHomered))
  }
  return out
}

function chooseBestPlayerBook(
  props: Array<{ vendor: string | null; line_value: string | null; milestone_odds: number | null; over_odds: number | null }>,
): PlayerBookOdds | null {
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
  const all = [...bestByVendor.values()]
    .sort((a, b) => oddsProfitScore(b.odds) - oddsProfitScore(a.odds))
    .map((entry) => ({ vendor: entry.vendor, odds: entry.odds }))
  if (!all.length) return null
  return {
    bestOdds: all[0]!.odds,
    bestVendor: all[0]!.vendor,
    all,
  }
}

export default function ProjectionsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { supabase, hasSubscription, session } = useWebAuth()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<DailyProjection[]>([])
  const [weightedRows, setWeightedRows] = useState<DailyProjection[]>([])
  const [contactQualityRows, setContactQualityRows] = useState<DailyProjection[]>([])
  const [projectionModelTab, setProjectionModelTab] = useState<'default' | 'weighted' | 'contact_quality'>('default')
  const [games, setGames] = useState<ScheduleGame[]>([])
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [pickState, setPickState] = useState<Record<string, boolean | null>>({})
  const [pickBusy, setPickBusy] = useState<string | null>(null)
  const [matchupLoading, setMatchupLoading] = useState(false)
  const [matchupFor, setMatchupFor] = useState<DailyProjection | null>(null)
  const [matchupData, setMatchupData] = useState<any>(null)
  const [matchupTab, setMatchupTab] = useState<'default' | 'pitch'>('default')
  const [pitchCarouselIndex, setPitchCarouselIndex] = useState(0)
  const [playerInputs, setPlayerInputs] = useState<any>(null)
  const [selectedYear, setSelectedYear] = useState<number>(2026)
  const [liveGames, setLiveGames] = useState<any[]>([])
  const [probablePitchers, setProbablePitchers] = useState<Record<string, { home: string | null; away: string | null }>>({})
  const [lineupByGame, setLineupByGame] = useState<Record<string, GameLineup | null>>({})
  const [playerOdds, setPlayerOdds] = useState<Record<string, PlayerBookOdds | null>>({})
  const [playerQuery, setPlayerQuery] = useState(searchParams.get('q') ?? '')
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
    if (!supabase) return
    setLoading(true)
    let cancelled = false
    const prevDate = new Date(`${displayDate}T12:00:00Z`)
    prevDate.setUTCDate(prevDate.getUTCDate() - 1)
    const nextDate = new Date(`${displayDate}T12:00:00Z`)
    nextDate.setUTCDate(nextDate.getUTCDate() + 1)
    const prevIso = prevDate.toISOString().slice(0, 10)
    const nextIso = nextDate.toISOString().slice(0, 10)

    void Promise.all([
      listDailyHrProjectionsAllModels(supabase, displayDate),
      getGamesForDate(supabase, displayDate),
      supabase
        .from('bdl_games')
        .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev,status,scoring_summary')
        .gte('date', prevIso)
        .lte('date', nextIso),
    ])
      .then(([allModels, sched, live]) => {
        if (cancelled) return
        setRows(allModels.default)
        setWeightedRows(allModels.weighted_pitch_arsenal)
        setContactQualityRows(allModels.contact_quality)
        setGames(sched)
        const raw = (live.data ?? []) as any[]
        const dayIso = displayDate
        setLiveGames(raw.filter((lg) => bdlRowMatchesCalendarDay(lg, dayIso)))

        /* DB often only has `default` until sync runs; hydrate weighted/contact from API without blocking first paint. */
        const base = import.meta.env.VITE_API_BASE_URL ?? ''
        const q = encodeURIComponent(displayDate)
        const needW = allModels.default.length > 0 && allModels.weighted_pitch_arsenal.length === 0
        const needC = allModels.default.length > 0 && allModels.contact_quality.length === 0
        if (base && (needW || needC)) {
          void Promise.all([
            needW
              ? fetch(`${base}/bdl/projections/weighted?date=${q}`).then((r) => (r.ok ? r.json() : null))
              : Promise.resolve(null),
            needC
              ? fetch(`${base}/bdl/projections/contact-quality?date=${q}`).then((r) => (r.ok ? r.json() : null))
              : Promise.resolve(null),
          ])
            .then(([wJson, cJson]) => {
              if (cancelled) return
              const wRows = (wJson as { rows?: DailyProjection[] } | null)?.rows
              const cRows = (cJson as { rows?: DailyProjection[] } | null)?.rows
              if (needW && wRows?.length) setWeightedRows(wRows)
              if (needC && cRows?.length) setContactQualityRows(cRows)
            })
            .catch(() => {})
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
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
        .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev,status,scoring_summary')
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

  useEffect(() => {
    const base = import.meta.env.VITE_API_BASE_URL ?? ''
    if (!base) return
    void fetch(`${base}/bdl/lineups/slate?date=${encodeURIComponent(displayDate)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: Record<string, GameLineup | null> } | null) => {
        const next: Record<string, GameLineup | null> = {}
        for (const [gameId, lineup] of Object.entries(json?.data ?? {})) {
          next[`game:${gameId}`] = lineup
        }
        setLineupByGame(next)
      })
      .catch(() => {
        setLineupByGame({})
      })
  }, [displayDate])

  const activeRows =
    projectionModelTab === 'weighted'
      ? weightedRows
      : projectionModelTab === 'contact_quality'
        ? contactQualityRows
        : rows

  const filteredRows = useMemo(() => {
    let out = activeRows
    if (!hasSubscription && games.length > 0) {
      const idx =
        displayDate.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % games.length
      const g = games[idx]
      const allowed = new Set(
        [g.awayTeam, g.homeTeam]
          .map((t) => normalizeTeamCode(t ?? '') ?? '')
          .filter(Boolean),
      )
      out = out.filter((r) => {
        const code = normalizeTeamCode(r.team ?? '') ?? ''
        return Boolean(code) && allowed.has(code)
      })
    }
    if (selectedTeam) out = out.filter((r) => (normalizeTeamCode(r.team ?? '') ?? '').toUpperCase() === selectedTeam)
    if (selectedPlayerId) out = out.filter((r) => r.playerId === selectedPlayerId)
    if (playerQuery.trim()) {
      const q = normalizePlayerName(playerQuery)
      out = out.filter((r) => normalizePlayerName(r.name).includes(q))
    }
    return out
  }, [activeRows, displayDate, games, hasSubscription, playerQuery, selectedPlayerId, selectedTeam])

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

      const next: Record<string, PlayerBookOdds | null> = {}
      const propsByStat = new Map<string, Array<{ vendor: string | null; line_value: string | null; milestone_odds: number | null; over_odds: number | null }>>()
      for (const p of props as any[]) {
        const sid = bdlToStat.get(Number(p.bdl_player_id))
        if (!sid) continue
        if (!propsByStat.has(sid)) propsByStat.set(sid, [])
        propsByStat.get(sid)!.push(p)
      }
      for (const [sid, statProps] of propsByStat) {
        const best = chooseBestPlayerBook(statProps)
        if (best) next[sid] = best
      }
      setPlayerOdds(next)
    })()
  }, [filteredRows, games, supabase])

  const selectedPlayer = useMemo(
    () => activeRows.find((r) => r.playerId === selectedPlayerId) ?? null,
    [activeRows, selectedPlayerId],
  )

  function matchupPitchersForTeams(gameId?: string | number | null): { home: string | null; away: string | null } {
    const lineup = /^\d+$/.test(String(gameId ?? ''))
      ? lineupByGame[`game:${gameId}`] ?? null
      : null
    const probable = probablePitchers[String(gameId ?? '')]
    return {
      home: probable?.home ?? lineup?.home_pitcher?.full_name ?? null,
      away: probable?.away ?? lineup?.away_pitcher?.full_name ?? null,
    }
  }

  const sections = useMemo(
    () =>
      groupProjectionsByTier(filteredRows).map((g) => ({
        key: g.tierKey,
        label: g.tierLabel.toUpperCase(),
        data: g.data,
      })),
    [filteredRows],
  )

  const gameResultByMatchup = useMemo(() => {
    const out = new Map<string, { completed: boolean; homerHitters: Set<string> }>()
    for (const game of liveGames) {
      const home = (normalizeTeamCode(game.home_team_abbrev) ?? game.home_team_abbrev ?? '').toUpperCase()
      const away = (normalizeTeamCode(game.away_team_abbrev) ?? game.away_team_abbrev ?? '').toUpperCase()
      if (!home || !away) continue
      const status = String(game.status ?? '').toLowerCase()
      const completed = /final|completed|postponed|canceled/.test(status)
      const homerHitters = extractHomerHitters(game.scoring_summary)
      out.set(`${home}|${away}`, { completed, homerHitters })
      out.set(`${away}|${home}`, { completed, homerHitters })
    }
    return out
  }, [liveGames])

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
    const scheduleGame =
      games.find((g) => {
        const home = (normalizeTeamCode(g.homeTeam) ?? g.homeTeam).toUpperCase()
        const away = (normalizeTeamCode(g.awayTeam) ?? g.awayTeam).toUpperCase()
        return (home === team && away === opp) || (home === opp && away === team)
      }) ?? null
    const liveGame =
      liveGames.find((g) => {
        const home = (normalizeTeamCode(g.home_team_abbrev) ?? g.home_team_abbrev).toUpperCase()
        const away = (normalizeTeamCode(g.away_team_abbrev) ?? g.away_team_abbrev).toUpperCase()
        return (home === team && away === opp) || (home === opp && away === team)
      }) ?? null
    const home = (normalizeTeamCode(scheduleGame?.homeTeam ?? liveGame?.home_team_abbrev ?? '') ?? '').toUpperCase()
    const away = (normalizeTeamCode(scheduleGame?.awayTeam ?? liveGame?.away_team_abbrev ?? '') ?? '').toUpperCase()
    const gameId = liveGame?.bdl_game_id ?? scheduleGame?.gameId ?? null
    if (!home || !away) return { name: null, hand: null }
    const pitchers = matchupPitchersForTeams(gameId)
    return {
      name: team === home ? pitchers.away : pitchers.home,
      hand: null,
    }
  }

  function displayOpponentTeam(r: DailyProjection): string | null {
    return parseOpponentTeam(r)
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
      return
    }
    const player = activeRows.find((r) => r.playerId === playerId)
    const playerTeam = normalizeTeamCode(player?.team ?? '')
    const locked = liveGames.some((g) => {
      const a = normalizeTeamCode(g.away_team_abbrev ?? '')
      const h = normalizeTeamCode(g.home_team_abbrev ?? '')
      const status = String(g.status ?? '').toLowerCase()
      const started = !/scheduled|pre|not started/.test(status)
      return started && (playerTeam === a || playerTeam === h)
    })
    if (locked) {
      return
    }

    if (pickBusy) return
    setPickBusy(playerId)

    const currentlyPicked = Object.prototype.hasOwnProperty.call(pickState, playerId)
    if (currentlyPicked) {
      const { error } = await supabase
        .from('user_daily_picks')
        .delete()
        .eq('user_id', session.user.id)
        .eq('pick_date', displayDate)
        .eq('player_id', playerId)
      if (!error) {
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
      return
    }

    const { error } = await supabase.from('user_daily_picks').insert({
      user_id: session.user.id,
      pick_date: displayDate,
      player_id: playerId,
    })
    if (!error) {
      setPickState((prev) => ({ ...prev, [playerId]: null }))
      window.dispatchEvent(new CustomEvent('ah:picks-changed', { detail: { date: displayDate } }))
    }
    setPickBusy(null)
  }

  async function openMatchup(r: DailyProjection) {
    setMatchupFor(r)
    setMatchupData(null)
    setMatchupTab('default')
    setPitchCarouselIndex(0)
    setPlayerInputs(null)
    const opponentTeam = parseOpponentTeam(r)
    if (!opponentTeam) return
    const displayPitcher = displayOpponentPitcher(r)
    setMatchupLoading(true)
    try {
      const base = import.meta.env.VITE_API_BASE_URL ?? ''
      const [matchupRes, evRes, hrRes] = await Promise.all([
        fetch(
          `${base}/bdl/matchup-card?player_id=${encodeURIComponent(r.playerId)}&opponent_team=${encodeURIComponent(opponentTeam)}&season=${selectedYear}${displayPitcher.name ? `&pitcher_name=${encodeURIComponent(displayPitcher.name)}` : ''}`,
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
        <div className="pg-searchWrap">
          <input
            id="proj-search"
            className="pg-input pg-input--search"
            type="text"
            value={playerQuery}
            placeholder="Search player..."
            onChange={(e) => setPlayerQuery(e.target.value)}
            aria-label="Search players"
          />
        </div>
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
      <div className="pg-projModelBar" role="group" aria-label="Projection model">
        <button
          type="button"
          className={`pg-projModelTab ${projectionModelTab === 'default' ? 'is-active' : ''}`}
          onClick={() => setProjectionModelTab('default')}
        >
          AH Default
        </button>
        <button
          type="button"
          className={`pg-projModelTab ${projectionModelTab === 'weighted' ? 'is-active' : ''}`}
          onClick={() => setProjectionModelTab('weighted')}
        >
          Weighted Pitch Arsenal
        </button>
        <button
          type="button"
          className={`pg-projModelTab ${projectionModelTab === 'contact_quality' ? 'is-active' : ''}`}
          onClick={() => setProjectionModelTab('contact_quality')}
        >
          Contact Quality
        </button>
      </div>
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
                const bestBook = playerOdds[r.playerId] ?? null
                const bookOdds = formatBookOdds(bestBook?.bestOdds)
                const bookVendor = bestBook?.bestVendor ?? ''
                const team = (normalizeTeamCode(r.team ?? '') ?? '').toUpperCase()
                const opp = (displayOpponentTeam(r) ?? '').toUpperCase()
                const gameResult = team && opp ? gameResultByMatchup.get(`${team}|${opp}`) ?? null : null
                const didHomer = gameResult ? gameResult.homerHitters.has(normalizePlayerName(r.name)) : false
                const projectionStateClass =
                  didHomer
                    ? 'pg-card--projection-hit'
                    : gameResult?.completed
                      ? 'pg-card--projection-miss'
                      : 'pg-card--projection-pending'
                return (
                <div
                  key={r.playerId}
                  className={`pg-card pg-card--projection ${projectionStateClass}`}
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
                        aria-label="Toggle target pick"
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
                      <span className="pg-meta">
                        {(r.team ?? '—').toUpperCase()}
                      </span>
                    </div>
                    <span className="pg-matchup">
                      {(displayOpponentTeam(r) ?? '—').toUpperCase()} &bull; {displayPitcher.name ?? '—'}
                      {displayPitcher.hand ? ` (${displayPitcher.hand})` : ''}
                    </span>
                    <span className="pg-small">
                      {(r.position ?? '—').toUpperCase()}
                    </span>
                  </div>
                  <div className="pg-right">
                    <span className="pg-prob">{formatProbability(r.hrProbability)}</span>
                    <span
                      className="pg-odds"
                      style={{ color: tierColor(r.tier ?? 'D') }}
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
        <div className="pg-modalBackdrop" onClick={() => { setMatchupFor(null); setMatchupTab('default') }}>
          <div className="pg-modal pg-modal--matchup" onClick={(e) => e.stopPropagation()}>
            <div className="pg-modalHead">
              <h3>Matchup Comparison</h3>
              <button type="button" className="pg-clearBtn" onClick={() => { setMatchupFor(null); setMatchupTab('default') }}>Close</button>
            </div>
            <div className="pg-matchupBody">
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
                  const pitchArsenalRows = Array.isArray(matchupData?.pitch_arsenal_matchup)
                    ? (matchupData.pitch_arsenal_matchup as MatchupPitchRow[])
                    : []
                  return (
                    <>
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
                      <div className="pg-matchupTabs" style={{ marginTop: 10 }}>
                        <button
                          type="button"
                          className={`pg-matchupTab ${matchupTab === 'default' ? 'is-active' : ''}`}
                          onClick={() => setMatchupTab('default')}
                        >
                          Default
                        </button>
                        <button
                          type="button"
                          className={`pg-matchupTab ${matchupTab === 'pitch' ? 'is-active' : ''}`}
                          onClick={() => setMatchupTab('pitch')}
                        >
                          Pitch
                        </button>
                      </div>

                      {matchupTab === 'default' ? (
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
                        </>
                      ) : pitchArsenalRows.length ? (
                        <div className="pg-pitchArsenalWrap" style={{ marginTop: 10 }}>
                          {(() => {
                            const sortedArsenal = [...pitchArsenalRows].sort((a, b) => {
                              const ua = a.usage != null ? Number(a.usage) : 0
                              const ub = b.usage != null ? Number(b.usage) : 0
                              return ub - ua
                            })
                            const n = sortedArsenal.length
                            const idx = n ? ((pitchCarouselIndex % n) + n) % n : 0
                            const row = sortedArsenal[idx]!
                            const usage = row.usage != null ? Number(row.usage) : null
                            const usageBig = usage != null && usage >= 20
                            const batterIso = row.batter_iso != null ? Number(row.batter_iso) : null
                            const batterHot = batterIso != null && batterIso >= 0.25
                            return (
                              <>
                                <div className="pg-label">Full arsenal overview</div>
                                <div className="pg-pitchOverview">
                                  {sortedArsenal.map((pr, i) => {
                                    const u = pr.usage != null ? Number(pr.usage) : null
                                    const g = arsenalPitchGrade(pr)
                                    return (
                                      <button
                                        key={`${pr.pitch_type ?? pr.pitch_name ?? 'p'}-${i}`}
                                        type="button"
                                        className={`pg-pitchOverviewChip ${i === idx ? 'is-active' : ''}`}
                                        onClick={() => setPitchCarouselIndex(i)}
                                      >
                                        <span className="pg-pitchOverviewName">{pr.pitch_name ?? pr.pitch_type ?? 'Pitch'}</span>
                                        <span className="pg-pitchOverviewUsage">{u != null ? `${u.toFixed(0)}%` : '—'}</span>
                                        <span
                                          className={`pg-pitchOverviewGrade ${g !== '—' ? `grade-${g}` : ''}`}
                                        >
                                          {g}
                                        </span>
                                      </button>
                                    )
                                  })}
                                </div>
                                <div className="pg-pitchCarousel">
                                  <button
                                    type="button"
                                    className="pg-pitchCarouselBtn"
                                    aria-label="Previous pitch"
                                    onClick={() => setPitchCarouselIndex((c) => (n ? (c - 1 + n) % n : 0))}
                                  >
                                    ←
                                  </button>
                                  <div className="pg-pitchCarouselCard">
                                    <div className="pg-arsenalTop">
                                      <div>
                                        <div className="pg-arsenalPitch">{row.pitch_name ?? row.pitch_type ?? 'Pitch'}</div>
                                        <div className="pg-small">{row.pitch_type ?? '—'}</div>
                                      </div>
                                      <span className={`pg-pill ${usageBig ? 'is-green' : ''}`}>
                                        Usage {usage != null ? `${usage.toFixed(1)}%` : '—'}
                                      </span>
                                    </div>
                                    <div className="pg-arsenalStats">
                                      <div className="pg-arsenalSide">
                                        <div className="pg-label">Pitcher</div>
                                        <div className="pg-arsenalMetric">BA allowed: {formatMetric(row.pitcher_ba_allowed)}</div>
                                        <div className="pg-arsenalMetric">SLG allowed: {formatMetric(row.pitcher_slg_allowed)}</div>
                                        <div className="pg-arsenalMetric">wOBA allowed: {formatMetric(row.pitcher_woba_allowed)}</div>
                                        <div className="pg-arsenalMetric">xSLG allowed: {formatMetric(row.pitcher_est_slg_allowed)}</div>
                                        <div className="pg-arsenalMetric">xwOBA allowed: {formatMetric(row.pitcher_est_woba_allowed)}</div>
                                        <div className="pg-arsenalMetric">Hard-hit allowed: {formatPercent(row.pitcher_hard_hit_percent)}</div>
                                      </div>
                                      <div className="pg-arsenalSide">
                                        <div className="pg-label">Batter vs this pitch</div>
                                        <div className={`pg-arsenalMetric ${batterHot ? 'is-green' : ''}`}>ISO: {formatMetric(row.batter_iso)}</div>
                                        <div className="pg-arsenalMetric">BA: {formatMetric(row.batter_ba)}</div>
                                        <div className="pg-arsenalMetric">SLG: {formatMetric(row.batter_slg)}</div>
                                        <div className="pg-arsenalMetric">wOBA: {formatMetric(row.batter_woba)}</div>
                                        <div className="pg-arsenalMetric">xSLG: {formatMetric(row.batter_est_slg)}</div>
                                        <div className="pg-arsenalMetric">xwOBA: {formatMetric(row.batter_est_woba)}</div>
                                        <div className="pg-arsenalMetric">K%: {formatPercent(row.batter_k_percent)}</div>
                                        <div className="pg-arsenalMetric">Hard-hit %: {formatPercent(row.batter_hard_hit_percent)}</div>
                                      </div>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    className="pg-pitchCarouselBtn"
                                    aria-label="Next pitch"
                                    onClick={() => setPitchCarouselIndex((c) => (n ? (c + 1) % n : 0))}
                                  >
                                    →
                                  </button>
                                </div>
                                <div className="pg-pitchCarouselHint">
                                  Pitch {idx + 1} of {n} — use arrows or tap a pitch above
                                </div>
                              </>
                            )
                          })()}
                        </div>
                      ) : (
                        <p className="pg-sub" style={{ marginTop: 10 }}>
                          No pitch arsenal matchup data found for this pitcher/batter pairing.
                        </p>
                      )}
                    </>
                  )
                })()}
                {!matchupData && !playerInputs ? (
                  <p className="pg-sub">No data found for this player/season. Try selecting a different year.</p>
                ) : null}
              </>
            )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
