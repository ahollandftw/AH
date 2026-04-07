import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  formatProbability,
  getBallparkForHomeTeam,
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
import { resolveApiBaseUrl } from '../utils/apiBase.ts'
import hrIcon96 from '../../../../data/icons8-home-run-96.png'
import hrIcon64 from '../../../../data/icons8-home-run-64.png'

type WeatherSlateEntry = {
  home_team: string | null
  stadium: string | null
  weather?: {
    current?: {
      temp?: number
      feels_like?: number
      wind_speed?: number
      wind_deg?: number
      weather?: Array<{ main?: string; description?: string }>
    }
  }
  error?: string
}

type WeatherDisplay = {
  tempText: string | null
  weatherText: string | null
  weatherIcon: string | null
  windText: string | null
  windRotation: number | null
  roofText: string | null
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

function normalizePlayerName(name: string | null | undefined): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveLineupProjection(
  p: LineupPlayer,
  teamCode: string,
  rows: DailyProjection[],
  lineupStatByBdlId: Map<number, string>,
): DailyProjection | null {
  const fromLineup = p.stat_player_id?.trim()
  const fromBdl =
    p.bdl_player_id != null && p.bdl_player_id > 0 ? lineupStatByBdlId.get(p.bdl_player_id) : undefined
  const statId = fromLineup || fromBdl || null
  if (statId) {
    const byId = rows.find((r) => r.playerId === statId)
    if (byId) return byId
  }
  const key = normalizePlayerName(p.full_name)
  if (!key) return null
  const teamNorm = (normalizeTeamCode(teamCode) ?? '').toUpperCase()
  const candidates = rows.filter((r) => {
    if (normalizePlayerName(r.name) !== key) return false
    if (!teamNorm) return true
    return (normalizeTeamCode(r.team ?? '') ?? '').toUpperCase() === teamNorm
  })
  if (candidates.length === 1) return candidates[0] ?? null
  return null
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

function oddsProfitScore(odds: number): number {
  if (odds >= 0) return odds
  return 10000 / Math.abs(odds)
}

function buildTooltip(all: Array<{ vendor: string; odds: number }>): string {
  return all.map((entry) => `${sportsbookLabel(entry.vendor)} ${formatBookOdds(entry.odds)}`).join('\n')
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

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360
}

function signedAngleDelta(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180
}

function weatherIconFor(main?: string | null, description?: string | null): string {
  const text = `${main ?? ''} ${description ?? ''}`.trim().toLowerCase()
  if (/thunder|storm/.test(text)) return '⛈️'
  if (/snow|sleet|ice/.test(text)) return '❄️'
  if (/rain|drizzle|shower/.test(text)) return '🌧️'
  if (/mist|fog|haze|smoke/.test(text)) return '🌫️'
  if (/overcast/.test(text)) return '☁️'
  if (/cloud/.test(text)) return '⛅'
  if (/clear|sun/.test(text)) return '☀️'
  return '🌤️'
}

function formatWindForField(entry: WeatherSlateEntry | undefined, homeTeam: string): Pick<WeatherDisplay, 'windText' | 'windRotation' | 'roofText'> {
  const park = getBallparkForHomeTeam(homeTeam)
  if (!park) return { windText: null, windRotation: null, roofText: null }
  if (park.roof === 'dome') {
    return { windText: null, windRotation: null, roofText: 'Indoor dome' }
  }
  const windSpeed = entry?.weather?.current?.wind_speed
  const windDeg = entry?.weather?.current?.wind_deg
  if (windSpeed == null || windDeg == null) {
    return {
      windText: null,
      windRotation: null,
      roofText: park.roof === 'retractable' ? 'Retractable roof park' : null,
    }
  }
  const windTo = normalizeDeg(windDeg + 180)
  const delta = signedAngleDelta(park.cfBearing, windTo)
  let direction = 'toward RF'
  if (Math.abs(delta) <= 30) direction = 'out to CF'
  else if (Math.abs(delta) >= 150) direction = 'in to home plate'
  else if (delta < 0) direction = 'toward LF'
  return {
    windText: `${Math.round(windSpeed)} mph ${direction}`,
    windRotation: delta,
    roofText: park.roof === 'retractable' ? 'Retractable roof park' : null,
  }
}

function getWeatherDisplay(entry: WeatherSlateEntry | undefined, homeTeam: string): WeatherDisplay | null {
  if (!entry || entry.error || !entry.weather?.current) return null
  const current = entry.weather.current
  const detail = current.weather?.[0]
  const tempText = current.temp != null ? `${Math.round(current.temp)}°F` : null
  const weatherText = detail?.description
    ? detail.description.replace(/\b\w/g, (ch) => ch.toUpperCase())
    : null
  const { windText, windRotation, roofText } = formatWindForField(entry, homeTeam)
  if (!tempText && !weatherText && !windText && !roofText) return null
  return {
    tempText,
    weatherText,
    weatherIcon: weatherText ? weatherIconFor(detail?.main, detail?.description) : null,
    windText,
    windRotation,
    roofText,
  }
}

function shiftIsoDate(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function formatEtTime(utc: string | null | undefined): string {
  if (!utc) return 'TBD'
  return new Date(utc).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  })
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function formatPitchMetric(value: unknown, digits = 3): string {
  const n = toFiniteNumber(value)
  return n == null ? '—' : n.toFixed(digits)
}

function formatPitchPercent(value: unknown, digits = 1): string {
  const n = toFiniteNumber(value)
  return n == null ? '—' : `${n.toFixed(digits)}%`
}

function gradeFromPitchScore(score: number | null): 'A' | 'B' | 'C' | 'D' | 'F' | '—' {
  if (score == null || !Number.isFinite(score)) return '—'
  if (score >= 0.9) return 'A'
  if (score >= 0.35) return 'B'
  if (score >= -0.1) return 'C'
  if (score >= -0.55) return 'D'
  return 'F'
}

function gradeClassName(grade: string): string {
  const normalized = /^[a-f]$/i.test(grade) ? grade.toLowerCase() : 'unknown'
  return `pg-pitchGradeBadge--${normalized}`
}

function zScorePitch(value: number | null, mean: number, std: number, invert = false): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const z = (value - mean) / std
  const adjusted = invert ? -z : z
  return Math.max(-2, Math.min(2, adjusted))
}

function computePitchRowScore(row: any): number | null {
  const parts: number[] = []
  const push = (value: number | null) => {
    if (value != null && Number.isFinite(value)) parts.push(value)
  }

  push(zScorePitch(toFiniteNumber(row?.pitcher_ba_allowed), 0.245, 0.035))
  push(zScorePitch(toFiniteNumber(row?.batter_ba), 0.245, 0.035))
  push(zScorePitch(toFiniteNumber(row?.pitcher_slg_allowed), 0.390, 0.080))
  push(zScorePitch(toFiniteNumber(row?.batter_slg), 0.390, 0.080))
  push(zScorePitch(toFiniteNumber(row?.pitcher_woba_allowed), 0.320, 0.040))
  push(zScorePitch(toFiniteNumber(row?.batter_woba), 0.320, 0.040))
  push(zScorePitch(toFiniteNumber(row?.pitcher_est_slg_allowed), 0.390, 0.080))
  push(zScorePitch(toFiniteNumber(row?.batter_est_slg), 0.390, 0.080))
  push(zScorePitch(toFiniteNumber(row?.pitcher_est_woba_allowed), 0.320, 0.040))
  push(zScorePitch(toFiniteNumber(row?.batter_est_woba), 0.320, 0.040))
  push(zScorePitch(toFiniteNumber(row?.pitcher_hard_hit_percent), 39, 10))
  push(zScorePitch(toFiniteNumber(row?.batter_hard_hit_percent), 39, 10))
  push(zScorePitch(toFiniteNumber(row?.pitcher_k_percent), 23, 7, true))
  push(zScorePitch(toFiniteNumber(row?.batter_k_percent), 23, 7, true))
  push(zScorePitch(toFiniteNumber(row?.pitcher_whiff_percent), 28, 9, true))
  push(zScorePitch(toFiniteNumber(row?.batter_whiff_percent), 28, 9, true))

  if (!parts.length) return null
  return parts.reduce((sum, value) => sum + value, 0) / parts.length
}

function computeOverallPitchGrade(rows: any[]): { grade: string; score: number | null; ratedPitches: number } {
  let weightedSum = 0
  let weightTotal = 0
  let ratedPitches = 0
  for (const row of rows) {
    const score = computePitchRowScore(row)
    if (score == null) continue
    const usage = Math.max(0, toFiniteNumber(row?.usage) ?? 0)
    const weight = usage > 0 ? usage : 1
    weightedSum += score * weight
    weightTotal += weight
    ratedPitches += 1
  }
  const finalScore = weightTotal > 0 ? weightedSum / weightTotal : null
  return {
    grade: gradeFromPitchScore(finalScore),
    score: finalScore,
    ratedPitches,
  }
}

function extractHomerHitters(scoringSummary: any): Set<string> {
  const out = new Set<string>()
  const plays = Array.isArray(scoringSummary) ? scoringSummary : []
  for (const p of plays) {
    const txt = String(p?.play ?? '').trim()
    const lower = txt.toLowerCase()
    if (!/home run|homer|grand slam/i.test(lower)) continue
    const beforeHomered = txt.split(/\bhomered\b/i)[0]?.trim()
    if (beforeHomered) out.add(beforeHomered.toLowerCase())
  }
  return out
}

function didPlayerHomer(fullName: string | null | undefined, homerHitters: Set<string>): boolean {
  const name = String(fullName ?? '').trim().toLowerCase()
  if (!name) return false
  for (const hitter of homerHitters) {
    if (!hitter) continue
    if (name === hitter) return true
    if (name.endsWith(hitter)) return true
    if (hitter.endsWith(name)) return true
  }
  return false
}

export default function DugoutPage() {
  const { supabase, hasSubscription, session } = useWebAuth()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<DailyProjection[]>([])
  const [games, setGames] = useState<ScheduleGame[]>([])
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [displayDate, setDisplayDate] = useState(getAppDisplayDateIso())
  const [expandedGameIds, setExpandedGameIds] = useState<Set<string>>(() => new Set())
  const [pickState, setPickState] = useState<Record<string, boolean | null>>({})
  const [pickBusy, setPickBusy] = useState<string | null>(null)
  const [pickMsg, setPickMsg] = useState('')
  const [matchupLoading, setMatchupLoading] = useState(false)
  const [matchupFor, setMatchupFor] = useState<DailyProjection | null>(null)
  const [matchupData, setMatchupData] = useState<any>(null)
  const [matchupTab, setMatchupTab] = useState<'default' | 'pitch'>('default')
  const [liveGames, setLiveGames] = useState<any[]>([])
  const [selectedYear, setSelectedYear] = useState<number>(2026)
  const [playerInputs, setPlayerInputs] = useState<any>(null)
  const [weatherByHome, setWeatherByHome] = useState<Record<string, WeatherSlateEntry>>({})
  const [lineupByGame, setLineupByGame] = useState<Record<string, GameLineup | null>>({})
  /** BDL id → stats `player_id` for lineup rows missing `stat_player_id` from the feed */
  const [lineupStatByBdlId, setLineupStatByBdlId] = useState<Map<number, string>>(() => new Map())
  const [lineupsLoading, setLineupsLoading] = useState(false)
  // { [bdlGameId]: { home: pitcherName|null, away: pitcherName|null } }
  const [probablePitchers, setProbablePitchers] = useState<Record<string, { home: string | null; away: string | null }>>({})
  // { [statPlayerId]: americanOdds number }
  const [playerOdds, setPlayerOdds] = useState<Record<string, PlayerBookOdds | null>>({})
  const [playerOddsByName, setPlayerOddsByName] = useState<Record<string, PlayerBookOdds | null>>({})

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
    const prevDate = shiftIsoDate(displayDate, -1)
    const nextDate = shiftIsoDate(displayDate, 1)
    void Promise.all([
      listDailyHrProjections(supabase, displayDate),
      getGamesForDate(supabase, displayDate),
      supabase
        .from('bdl_games')
        .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev,status,home_score,away_score,home_hits,away_hits,home_errors,away_errors,home_inning_scores,away_inning_scores,current_period,scoring_summary')
        .gte('date', prevDate)
        .lte('date', nextDate),
    ])
      .then(([proj, sched, live]) => {
        setRows(proj)
        setGames(sched)
        setExpandedGameIds(new Set(sched.map((g) => g.gameId)))
        const raw = (live.data ?? []) as any[]
        const dayIso = displayDate
        setLiveGames(raw.filter((lg) => bdlRowMatchesCalendarDay(lg, dayIso)))
      })
      .finally(() => setLoading(false))
  }, [supabase, displayDate])

  // Fetch probable pitchers from BDL for this date
  useEffect(() => {
    const base = resolveApiBaseUrl()
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
      const prevDate = shiftIsoDate(displayDate, -1)
      const nextDate = shiftIsoDate(displayDate, 1)
      void supabase
        .from('bdl_games')
        .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev,status,home_score,away_score,home_hits,away_hits,home_errors,away_errors,home_inning_scores,away_inning_scores,current_period,scoring_summary')
        .gte('date', prevDate)
        .lte('date', nextDate)
        .then(({ data }) => {
          const raw = (data ?? []) as any[]
          const dayIso = displayDate
          setLiveGames(raw.filter((lg) => bdlRowMatchesCalendarDay(lg, dayIso)))
        })
    }, 60000)
    return () => clearInterval(id)
  }, [displayDate, supabase])

  // Fetch HR odds for visible games so scoreboard cards and homer text can use them.
  useEffect(() => {
    if (!supabase || !liveGames.length) {
      setPlayerOdds({})
      setPlayerOddsByName({})
      return
    }
    const bdlGameIds = liveGames.map((g: any) => g.bdl_game_id).filter(Boolean) as number[]
    if (!bdlGameIds.length) {
      setPlayerOdds({})
      setPlayerOddsByName({})
      return
    }

    void (async () => {
      const { data: props } = await supabase
        .from('bdl_player_props')
        .select('bdl_player_id,line_value,milestone_odds,over_odds,vendor')
        .in('bdl_game_id', bdlGameIds)
        .eq('prop_type', 'home_runs')

      if (!props?.length) {
        setPlayerOdds({})
        setPlayerOddsByName({})
        return
      }

      const bdlIds = [...new Set(props.map((p: any) => Number(p.bdl_player_id)).filter((id) => Number.isFinite(id) && id > 0))]
      const { data: xref } = await supabase
        .from('bdl_players')
        .select('bdl_id,stat_player_id,full_name')
        .in('bdl_id', bdlIds.slice(0, 500))
      const bdlToStat = new Map<number, string>()
      const bdlToName = new Map<number, string>()
      for (const row of xref ?? []) {
        const bid = Number((row as any).bdl_id)
        const sid = String((row as any).stat_player_id ?? '')
        const name = String((row as any).full_name ?? '').trim()
        if (sid) bdlToStat.set(bid, sid)
        if (name) bdlToName.set(bid, name)
      }

      const next: Record<string, PlayerBookOdds | null> = {}
      const nextByName: Record<string, PlayerBookOdds | null> = {}
      const propsByStat = new Map<string, Array<{ vendor: string | null; line_value: string | null; milestone_odds: number | null; over_odds: number | null }>>()
      const propsByName = new Map<string, Array<{ vendor: string | null; line_value: string | null; milestone_odds: number | null; over_odds: number | null }>>()
      for (const p of props as any[]) {
        const bid = Number(p.bdl_player_id)
        const sid = bdlToStat.get(bid)
        if (sid) {
          if (!propsByStat.has(sid)) propsByStat.set(sid, [])
          propsByStat.get(sid)!.push(p)
        }
        const nameKey = normalizePlayerName(bdlToName.get(bid))
        if (nameKey) {
          if (!propsByName.has(nameKey)) propsByName.set(nameKey, [])
          propsByName.get(nameKey)!.push(p)
          const last = nameKey.split(' ').filter(Boolean).at(-1)
          if (last) {
            if (!propsByName.has(last)) propsByName.set(last, [])
            propsByName.get(last)!.push(p)
          }
        }
      }
      for (const [sid, statProps] of propsByStat) {
        const best = chooseBestPlayerBook(statProps)
        if (best) next[sid] = best
      }
      for (const [nameKey, nameProps] of propsByName) {
        const best = chooseBestPlayerBook(nameProps)
        if (best) nextByName[nameKey] = best
      }
      setPlayerOdds(next)
      setPlayerOddsByName(nextByName)
    })()
  }, [supabase, liveGames])

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

  const oddsByName = useMemo(() => {
    const m = new Map<string, PlayerBookOdds>()
    for (const [key, info] of Object.entries(playerOddsByName)) {
      if (!key || !info) continue
      m.set(key, info)
    }
    for (const r of rows) {
      const info = playerOdds[r.playerId]
      if (!info) continue
      const key = normalizePlayerName(r.name)
      if (!key || m.has(key)) continue
      m.set(key, info)
      const last = key.split(' ').filter(Boolean).at(-1)
      if (last && !m.has(last)) m.set(last, info)
    }
    return m
  }, [playerOdds, playerOddsByName, rows])

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
    const base = resolveApiBaseUrl()
    if (visibleGames.length === 0) {
      setWeatherByHome({})
      return
    }
    const homes = [
      ...new Set(visibleGames.map((g) => normalizeTeamCode(g.homeTeam) ?? g.homeTeam)),
    ]
    const ac = new AbortController()
    void fetch(`${base}/bdl/weather/slate?date=${encodeURIComponent(displayDate)}&homes=${encodeURIComponent(homes.join(','))}`, {
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
  }, [displayDate, visibleGames])

  useEffect(() => {
    const base = resolveApiBaseUrl()
    const ac = new AbortController()
    setLineupsLoading(true)
    void fetch(`${base}/bdl/lineups/slate?date=${encodeURIComponent(displayDate)}`, {
      signal: ac.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: Record<string, GameLineup | null> } | null) => {
        if (!json?.data) {
          setLineupByGame({})
          return
        }
        const next: Record<string, GameLineup | null> = {}
        for (const [gameId, lineup] of Object.entries(json.data)) {
          next[`game:${gameId}`] = lineup
        }
        setLineupByGame(next)
      })
      .catch(() => {
        setLineupByGame({})
      })
      .finally(() => {
        if (!ac.signal.aborted) setLineupsLoading(false)
      })
    return () => {
      ac.abort()
      setLineupsLoading(false)
    }
  }, [displayDate])

  useEffect(() => {
    if (!supabase) return
    const ids = new Set<number>()
    for (const lu of Object.values(lineupByGame)) {
      if (!lu) continue
      for (const side of [lu.away, lu.home] as const) {
        for (const e of side) {
          if (e?.bdl_player_id != null && e.bdl_player_id > 0) ids.add(e.bdl_player_id)
        }
      }
    }
    if (!ids.size) {
      setLineupStatByBdlId(new Map())
      return
    }
    const idList = [...ids].slice(0, 500)
    let cancelled = false
    void supabase
      .from('bdl_players')
      .select('bdl_id,stat_player_id')
      .in('bdl_id', idList)
      .then(({ data }) => {
        if (cancelled) return
        const m = new Map<number, string>()
        for (const row of data ?? []) {
          const bid = Number((row as { bdl_id?: number }).bdl_id)
          const sid = String((row as { stat_player_id?: string | null }).stat_player_id ?? '').trim()
          if (Number.isFinite(bid) && bid > 0 && sid) m.set(bid, sid)
        }
        setLineupStatByBdlId(m)
      })
    return () => {
      cancelled = true
    }
  }, [supabase, lineupByGame])

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
      if (live.start_time_utc) return `${formatEtTime(live.start_time_utc)} ET`
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

  function parseOpponentTeam(r: DailyProjection): string | null {
    const txt = (r.opponent ?? '').trim()
    if (!txt) return null
    const m = txt.match(/(?:vs|@)\s+([A-Za-z]{2,4})/i)
    return normalizeTeamCode(m?.[1] ?? '')?.toUpperCase() ?? null
  }

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

  function displayOpponentPitcher(r: DailyProjection): string | null {
    if (r.opponentPitcher) return r.opponentPitcher
    const team = (normalizeTeamCode(r.team ?? '') ?? '').toUpperCase()
    const opp = (parseOpponentTeam(r) ?? '').toUpperCase()
    if (!team || !opp) return null
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
    if (!home || !away) return null
    const pitchers = matchupPitchersForTeams(gameId)
    return team === home ? pitchers.away : pitchers.home
  }

  async function openMatchup(r: DailyProjection) {
    setMatchupFor(r)
    setMatchupData(null)
    setMatchupTab('default')
    setPlayerInputs(null)
    const opponentTeam = parseOpponentTeam(r) ?? ''
    if (!opponentTeam) return
    setMatchupLoading(true)
    try {
      const base = resolveApiBaseUrl()
      const opponentPitcher = displayOpponentPitcher(r)
      const q = new URLSearchParams({
        player_id: r.playerId,
        opponent_team: opponentTeam,
        season: String(selectedYear),
      })
      if (opponentPitcher) q.set('pitcher_name', opponentPitcher)
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
      <h1 className="pg-title">Scoreboard</h1>
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
                  const isExpanded = expandedGameIds.has(g.gameId)
                  const homeNorm = normalizeTeamCode(g.homeTeam) ?? g.homeTeam
                  const weatherDisplay = getWeatherDisplay(weatherByHome[homeNorm], homeNorm)
                  const lineupCacheKey = /^\d+$/.test(String(g.gameId))
                    ? `game:${g.gameId}`
                    : `pair:${displayDate}:${awayKey}:${homeKey}`
                  const homerHitters = extractHomerHitters(live?.scoring_summary)
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
                          <div className="pg-gameMetaCenter">
                            <div className="pg-weather pg-weather--status">
                              {formatGameStatus(live) || (live?.start_time_utc ? `${formatEtTime(live.start_time_utc)} ET` : 'TBD')}
                            </div>
                            {weatherDisplay ? (
                              <div
                                className="pg-weatherRow"
                                title={weatherByHome[homeNorm]?.stadium ?? ''}
                              >
                                {weatherDisplay.tempText ? (
                                  <span className="pg-weatherChip">
                                    <span className="pg-weatherIcon" aria-hidden="true">🌡️</span>
                                    <span>{weatherDisplay.tempText}</span>
                                  </span>
                                ) : null}
                                {weatherDisplay.weatherText ? (
                                  <span className="pg-weatherChip">
                                    <span className="pg-weatherIcon" aria-hidden="true">{weatherDisplay.weatherIcon}</span>
                                    <span>{weatherDisplay.weatherText}</span>
                                  </span>
                                ) : null}
                                {weatherDisplay.windText ? (
                                  <span className="pg-weatherChip">
                                    <span
                                      className="pg-weatherArrow"
                                      aria-hidden="true"
                                      style={{ transform: `rotate(${weatherDisplay.windRotation ?? 0}deg)` }}
                                    >
                                      ↑
                                    </span>
                                    <span>{weatherDisplay.windText}</span>
                                  </span>
                                ) : null}
                                {weatherDisplay.roofText ? (
                                  <span className="pg-weatherChip pg-weatherChip--roof">
                                    <span className="pg-weatherIcon" aria-hidden="true">🏟️</span>
                                    <span>{weatherDisplay.roofText}</span>
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        {!weatherDisplay && weatherByHome[homeNorm]?.error ? (
                          <div
                            className="pg-sub pg-sub--weatherError"
                            title={weatherByHome[homeNorm]?.error ?? weatherByHome[homeNorm]?.stadium ?? ''}
                          >
                            Weather unavailable
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
                            <div className="pg-label pg-scoringPlaysTitle" style={{ marginTop: 10 }}>Homers</div>
                            {(() => {
                              const playsAll = Array.isArray(live?.scoring_summary) ? [...live.scoring_summary].reverse() : []
                              const isHr = (txt: string) => /home run|homer|grand slam/i.test(txt)
                              const hrPlays = playsAll.filter((p: any) => isHr(String(p?.play ?? '')))
                              if (!hrPlays.length) return <div className="pg-sub">No homers yet.</div>
                              return (
                                <div className="pg-scoringPlays">
                                  {hrPlays.map((p: any, i: number) => {
                                    const txt = String(p?.play ?? '')
                                    const hitterName = txt.split(/\bhomered\b/i)[0]?.trim() ?? ''
                                    const hitterOdds = oddsByName.get(normalizePlayerName(hitterName)) ?? null
                                    const hitterOddsText = formatBookOdds(hitterOdds?.bestOdds)
                                    const displayText =
                                      hitterName && hitterOddsText
                                        ? txt.replace(hitterName, `${hitterName} (${hitterOddsText})`)
                                        : txt
                                    const oddsTooltip = hitterOdds ? buildTooltip(hitterOdds.all) : undefined
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
                                        <span className="pg-scoringPlayText" title={oddsTooltip}>{displayText}</span>
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
                              ) : (
                                <span className="pg-gamePick--muted">—</span>
                              )}
                            </div>
                            <div className="pg-batterProb">
                              <span style={{ color: awayPalette.primary }}>
                                {awayTop ? formatProbability(awayTop.hrProbability) : '—'}
                              </span>
                              {awayTop && playerOdds[awayTop.playerId]?.bestOdds != null ? (
                                <span className="pg-batterBookOdds" title={buildTooltip(playerOdds[awayTop.playerId]?.all ?? [])}>
                                  {sportsbookLabel(playerOdds[awayTop.playerId]?.bestVendor ?? '')} {formatBookOdds(playerOdds[awayTop.playerId]?.bestOdds)}
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
                              {homeTop && playerOdds[homeTop.playerId]?.bestOdds != null ? (
                                <span className="pg-batterBookOdds" title={buildTooltip(playerOdds[homeTop.playerId]?.all ?? [])}>
                                  {sportsbookLabel(playerOdds[homeTop.playerId]?.bestVendor ?? '')} {formatBookOdds(playerOdds[homeTop.playerId]?.bestOdds)}
                                </span>
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
                        onClick={() => {
                          setExpandedGameIds((prev) => {
                            const next = new Set(prev)
                            if (next.has(g.gameId)) next.delete(g.gameId)
                            else next.add(g.gameId)
                            return next
                          })
                        }}
                      >
                        {isExpanded ? 'Hide details' : 'Show details'}
                      </button>

                      {isExpanded ? (
                        <div className="pg-detailWrap">
                          <div className="pg-gameRows">
                            {/* Probable pitchers — BDL feed takes priority, fallback to projection data */}
                            {(() => {
                              const lineupPitchers = /^\d+$/.test(String(g.gameId))
                                ? lineupByGame[`game:${g.gameId}`] ?? null
                                : null
                              const bdlPitchers = live?.bdl_game_id ? probablePitchers[String(live.bdl_game_id)] : null
                              // BDL: home pitcher faces away batters; away pitcher faces home batters
                              const awayTeamPitcher = bdlPitchers?.home ?? lineupPitchers?.home_pitcher?.full_name ?? homeTop?.opponentPitcher
                              const awayTeamPitcherHand = bdlPitchers ? null : homeTop?.opponentPitcherHand
                              const homeTeamPitcher = bdlPitchers?.away ?? lineupPitchers?.away_pitcher?.full_name ?? awayTop?.opponentPitcher
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
                              const bdlLineup = lineupByGame[lineupCacheKey]
                              const bdlPitchers = live?.bdl_game_id ? probablePitchers[String(live.bdl_game_id)] : null
                              const isLoadingLineup = lineupsLoading && bdlLineup === undefined

                              const ordinal = (n: number) =>
                                n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`

                              if (isLoadingLineup) {
                                return <div className="pg-sub" style={{ marginTop: 12 }}>Loading lineup…</div>
                              }

                              const hasResolvedLineup =
                                !!bdlLineup &&
                                ((bdlLineup.away?.length ?? 0) > 0 || (bdlLineup.home?.length ?? 0) > 0)

                              if (hasResolvedLineup && bdlLineup) {
                                const renderBdlTeam = (
                                  entries: typeof bdlLineup.away,
                                  teamCode: string,
                                  source: 'official' | 'previous_game' | 'none' | undefined,
                                  teamPitcher: string | null,
                                ) => {
                                  const batters = entries.filter((e) => e.batting_order != null && e.batting_order > 0)
                                  return (
                                    <div className="pg-lineupTeam">
                                      <div className="pg-lineupTeamTitle">
                                        {teamCode}
                                        {source === 'previous_game' ? <span className="pg-lineupBadge">Projected</span> : null}
                                      </div>
                                      <div className="pg-lineupPitcherRow pg-lineupRow pg-lineupRow--pitcher">
                                        <span className="pg-lineupOrder">SP</span>
                                        <span className="pg-lineupPos">P</span>
                                        <span className="pg-lineupName pg-lineupName--plain">{teamPitcher ?? '—'}</span>
                                        <span className="pg-lineupProj">Pitcher</span>
                                        <span style={{ width: 32 }} />
                                      </div>
                                      {batters.map((p, idx) => {
                                        const proj = resolveLineupProjection(p, teamCode, rows, lineupStatByBdlId)
                                        const hasPick = proj && Object.prototype.hasOwnProperty.call(pickState, proj.playerId)
                                        const isHomer = didPlayerHomer(p.full_name ?? proj?.name, homerHitters)
                                        return (
                                          <div key={p.bdl_player_id ?? idx} className={`pg-lineupRow ${isHomer ? 'pg-lineupRow--homer' : ''}`}>
                                            <span className="pg-lineupOrder">{ordinal(idx + 1)}</span>
                                            <span className="pg-lineupPos">{String(p.position ?? '—').toUpperCase().slice(0, 3)}</span>
                                            {proj ? (
                                              <button
                                                type="button"
                                                className={`pg-lineupName ${isHomer ? 'pg-lineupName--homer' : ''}`}
                                                onClick={() => void openMatchup(proj)}
                                              >
                                                {p.full_name ?? proj.name}
                                              </button>
                                            ) : (
                                              <span className={`pg-lineupName pg-lineupName--plain ${isHomer ? 'pg-lineupName--homer' : ''}`}>{p.full_name ?? '—'}</span>
                                            )}
                                            <span className={`pg-lineupProj ${isHomer ? 'pg-lineupProj--homer' : ''}`}>
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
                                    </div>
                                  )
                                }
                                return (
                                  <div className="pg-lineupGrid" style={{ marginTop: 12 }}>
                                    {renderBdlTeam(
                                      bdlLineup.away,
                                      g.awayTeam,
                                      bdlLineup.away_source,
                                      bdlPitchers?.home ?? bdlLineup.home_pitcher?.full_name ?? homeTop?.opponentPitcher ?? null,
                                    )}
                                    {renderBdlTeam(
                                      bdlLineup.home,
                                      g.homeTeam,
                                      bdlLineup.home_source,
                                      bdlPitchers?.away ?? bdlLineup.away_pitcher?.full_name ?? awayTop?.opponentPitcher ?? null,
                                    )}
                                  </div>
                                )
                              }

                              // Projected fallback (from daily_hr_projections)
                              const toTeamKey = (t: string | null | undefined) => normalizeTeamCode(t ?? '') ?? t ?? ''
                              const awayKey = normalizeTeamCode(g.awayTeam) ?? g.awayTeam
                              const homeKey = normalizeTeamCode(g.homeTeam) ?? g.homeTeam
                              const awayLineup = rows
                                .filter((p) => toTeamKey(p.team) === awayKey)
                                .slice()
                                .sort((a, b) => (b.hrProbability ?? -1) - (a.hrProbability ?? -1))
                                .slice(0, 9)
                              const homeLineup = rows
                                .filter((p) => toTeamKey(p.team) === homeKey)
                                .slice()
                                .sort((a, b) => (b.hrProbability ?? -1) - (a.hrProbability ?? -1))
                                .slice(0, 9)

                              if (!awayLineup.length && !homeLineup.length) {
                                return (
                                  <div className="pg-sub" style={{ marginTop: 12 }}>
                                    No lineup data found for this game.
                                  </div>
                                )
                              }

                              const renderProjTeam = (lineup: typeof awayLineup, teamCode: string, teamPitcher: string | null) => (
                                <div className="pg-lineupTeam">
                                  <div className="pg-lineupTeamTitle">{teamCode} <span className="pg-lineupBadge">Projected</span></div>
                                  <div className="pg-lineupPitcherRow pg-lineupRow pg-lineupRow--pitcher">
                                    <span className="pg-lineupOrder">SP</span>
                                    <span className="pg-lineupPos">P</span>
                                    <span className="pg-lineupName pg-lineupName--plain">{teamPitcher ?? '—'}</span>
                                    <span className="pg-lineupProj">Pitcher</span>
                                    <span style={{ width: 32 }} />
                                  </div>
                                  {lineup.map((p, idx) => {
                                    const hasPick = Object.prototype.hasOwnProperty.call(pickState, p.playerId)
                                    const isHomer = didPlayerHomer(p.name, homerHitters)
                                    return (
                                      <div key={p.playerId} className={`pg-lineupRow ${isHomer ? 'pg-lineupRow--homer' : ''}`}>
                                        <span className="pg-lineupOrder">{ordinal(idx + 1)}</span>
                                        <span className="pg-lineupPos">{String(p.position ?? '—').toUpperCase().slice(0, 3)}</span>
                                        <button type="button" className={`pg-lineupName ${isHomer ? 'pg-lineupName--homer' : ''}`} onClick={() => void openMatchup(p)}>
                                          {p.name}
                                        </button>
                                        <span className={`pg-lineupProj ${isHomer ? 'pg-lineupProj--homer' : ''}`}>{formatProbability(p.hrProbability)}</span>
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
                                  {renderProjTeam(
                                    awayLineup,
                                    g.awayTeam,
                                    probablePitchers[String(live?.bdl_game_id ?? g.gameId)]?.home ?? homeTop?.opponentPitcher ?? null,
                                  )}
                                  {renderProjTeam(
                                    homeLineup,
                                    g.homeTeam,
                                    probablePitchers[String(live?.bdl_game_id ?? g.gameId)]?.away ?? awayTop?.opponentPitcher ?? null,
                                  )}
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
        <div className="pg-modalBackdrop" onClick={() => { setMatchupFor(null); setMatchupTab('default') }}>
          <div className="pg-modal pg-modal--matchup" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="pg-modalHead">
              <h3 className="pg-modalTitle">
                {matchupFor.name}
                <span className="pg-modalVs"> vs </span>
                {matchupData?.pitcher_name ?? (matchupFor.opponentPitcher ?? matchupFor.opponent)}
              </h3>
              <button type="button" className="pg-clearBtn" onClick={() => { setMatchupFor(null); setMatchupTab('default') }}>✕ Close</button>
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

                <div className="pg-matchupTabs">
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
                {/* Stats: pitcher left, batter right */}
                <div className="pg-matchupStatsGrid">
                  {/* Pitcher stats */}
                  <div className="pg-matchupStatCol">
                    <div className="pg-matchupStatHead">Pitcher Stats ({matchupData?.pitcher_data_season ?? matchupData?.season ?? selectedYear})</div>
                    <div className="pg-matchupStatRows">
                      {[
                        { label: 'Avg EV Allowed', val: matchupData?.pitcher_avg_hit_speed_allowed, hint: '90+ mph favors HR', good: matchupData?.pitcher_avg_hit_speed_allowed != null && Number(matchupData.pitcher_avg_hit_speed_allowed) >= 90 },
                        { label: 'EV95 Allowed', val: matchupData?.pitcher_ev95_allowed, hint: null, good: false },
                        { label: 'Barrel % Allowed', val: matchupData?.pitcher_barrel_allowed, hint: '10%+ favors HR', good: matchupData?.pitcher_barrel_allowed != null && Number(matchupData.pitcher_barrel_allowed) >= 10 },
                        { label: 'Hard-hit % Allowed', val: matchupData?.pitcher_hard_hit_allowed, hint: '40%+ favors HR', good: matchupData?.pitcher_hard_hit_allowed != null && Number(matchupData.pitcher_hard_hit_allowed) >= 40 },
                        { label: 'ISO Allowed', val: matchupData?.pitcher_iso_allowed != null ? Number(matchupData.pitcher_iso_allowed).toFixed(3) : null, hint: '.250+ favors HR', good: matchupData?.pitcher_iso_allowed != null && Number(matchupData.pitcher_iso_allowed) >= 0.25 },
                        { label: 'FB/LD % Allowed', val: matchupData?.pitcher_fbld_allowed, hint: '.45+ favors HR', good: matchupData?.pitcher_fbld_allowed != null && Number(matchupData.pitcher_fbld_allowed) >= 0.45 },
                        { label: 'K/9', val: matchupData?.pitcher_k_per_9, hint: 'Lower is better for batter', good: false },
                        { label: 'BB/9', val: matchupData?.pitcher_bb_per_9 != null ? Number(matchupData.pitcher_bb_per_9).toFixed(2) : null, hint: 'Higher is better for batter', good: false },
                        { label: 'HR Allowed', val: matchupData?.pitcher_hr_allowed ?? matchupData?.pitcher_hr_statcast, hint: null, good: false },
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
                    <div className="pg-matchupStatHead">Batter Stats ({matchupData?.batter_data_season ?? matchupData?.season ?? playerInputs?.season ?? selectedYear})</div>
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
                </>
                ) : (
                  (() => {
                    const pitchRows = Array.isArray(matchupData?.pitch_arsenal_matchup) && matchupData.pitch_arsenal_matchup.length > 0
                      ? matchupData.pitch_arsenal_matchup
                      : Array.isArray(matchupData?.pitch_type_matchup)
                        ? matchupData.pitch_type_matchup
                        : []
                    if (!pitchRows.length) {
                      return (
                        <div className="pg-bvpSection pg-bvpSection--empty">
                          <div className="pg-bvpLabel">Pitch Arsenal</div>
                          <p className="pg-sub">No pitch arsenal data found for this matchup.</p>
                        </div>
                      )
                    }
                    const overallPitchGrade = computeOverallPitchGrade(pitchRows)
                    return (
                      <div className="pg-arsenalGrid">
                        <div className="pg-pitchSummary">
                          <div>
                            <div className="pg-bvpLabel" style={{ marginBottom: 6 }}>Pitch Matchup Grade</div>
                            <div className="pg-small">
                              Weighted by pitcher usage across {overallPitchGrade.ratedPitches} rated pitch
                              {overallPitchGrade.ratedPitches === 1 ? '' : 'es'}
                            </div>
                          </div>
                          <div className="pg-pitchGradeBlock">
                            <span className={`pg-pitchGradeBadge ${gradeClassName(overallPitchGrade.grade)}`}>
                              {overallPitchGrade.grade}
                            </span>
                            <span className="pg-pitchGradeText">
                              {overallPitchGrade.score != null ? `${overallPitchGrade.score > 0 ? '+' : ''}${overallPitchGrade.score.toFixed(2)} edge` : 'No grade'}
                            </span>
                          </div>
                        </div>
                        {pitchRows.map((r: any, idx: number) => {
                          const usage = r?.usage != null ? Number(r.usage) : null
                          const usageBig = usage != null && usage >= 20
                          const rowScore = computePitchRowScore(r)
                          const rowGrade = gradeFromPitchScore(rowScore)
                          const comparisonRows = [
                            {
                              label: 'BA',
                              pitcher: formatPitchMetric(r?.pitcher_ba_allowed),
                              batter: formatPitchMetric(r?.batter_ba),
                            },
                            {
                              label: 'SLG',
                              pitcher: formatPitchMetric(r?.pitcher_slg_allowed),
                              batter: formatPitchMetric(r?.batter_slg),
                            },
                            {
                              label: 'wOBA',
                              pitcher: formatPitchMetric(r?.pitcher_woba_allowed),
                              batter: formatPitchMetric(r?.batter_woba),
                            },
                            {
                              label: 'xSLG',
                              pitcher: formatPitchMetric(r?.pitcher_est_slg_allowed),
                              batter: formatPitchMetric(r?.batter_est_slg),
                            },
                            {
                              label: 'xwOBA',
                              pitcher: formatPitchMetric(r?.pitcher_est_woba_allowed),
                              batter: formatPitchMetric(r?.batter_est_woba),
                            },
                            {
                              label: 'Hard-hit %',
                              pitcher: formatPitchPercent(r?.pitcher_hard_hit_percent),
                              batter: formatPitchPercent(r?.batter_hard_hit_percent),
                            },
                            {
                              label: 'K%',
                              pitcher: formatPitchPercent(r?.pitcher_k_percent),
                              batter: formatPitchPercent(r?.batter_k_percent),
                            },
                            {
                              label: 'Whiff%',
                              pitcher: formatPitchPercent(r?.pitcher_whiff_percent),
                              batter: formatPitchPercent(r?.batter_whiff_percent),
                            },
                          ]
                          return (
                            <div key={`${r?.pitch_type ?? r?.pitch_name ?? 'pitch'}-${idx}`} className="pg-arsenalCard">
                              <div className="pg-arsenalTop">
                                <div>
                                  <div className="pg-arsenalPitch">{r?.pitch_name ?? r?.pitch_type ?? 'Pitch'}</div>
                                  <div className="pg-small">{r?.pitch_type ?? '—'}</div>
                                </div>
                                <div className="pg-arsenalBadges">
                                  <span className={`pg-pill ${usageBig ? 'is-green' : ''}`}>
                                    Usage {usage != null ? `${usage.toFixed(1)}%` : '—'}
                                  </span>
                                  <span className={`pg-pitchGradeBadge ${gradeClassName(rowGrade)}`}>
                                    {rowGrade}
                                  </span>
                                </div>
                              </div>
                              <div className="pg-arsenalIsoRow">
                                <span className="pg-arsenalIsoLabel">ISO</span>
                                <span className="pg-arsenalIsoValue">{formatPitchMetric(r?.batter_iso)}</span>
                                <span className="pg-small">{rowScore != null ? `${rowScore > 0 ? '+' : ''}${rowScore.toFixed(2)} edge` : 'No edge score'}</span>
                              </div>
                              <div className="pg-arsenalCompare">
                                <div className="pg-arsenalCompareHead">
                                  <div className="pg-arsenalCompareHeadCell">Pitcher</div>
                                  <div className="pg-arsenalCompareHeadCell pg-arsenalCompareHeadCell--metric">Metric</div>
                                  <div className="pg-arsenalCompareHeadCell">Batter vs This Pitch</div>
                                </div>
                                <div className="pg-arsenalCompareRows">
                                  {comparisonRows.map((row) => (
                                    <div key={row.label} className="pg-arsenalCompareRow">
                                      <div className="pg-arsenalCompareValue">{row.pitcher}</div>
                                      <div className="pg-arsenalCompareMetric">{row.label}</div>
                                      <div className="pg-arsenalCompareValue pg-arsenalCompareValue--batter">{row.batter}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()
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
