import type { SupabaseClient } from '@supabase/supabase-js'
import { getBallparkForHomeTeam, normalizeMlbHomeTeam } from './mlbBallparks.js'
import { fetchOneCallWeather, type OneCallPayload } from './openWeather.js'

/** Slate/API response shape — stadium coords + OpenWeather; no DB row required. */
export type StadiumWeatherSlateEntry = {
  home_team: string | null
  stadium: string | null
  lat?: number
  lon?: number
  weather?: OneCallPayload
  game_start_utc?: string | null
  snapshot_time_utc?: string | null
  fetched_at?: string
  source?: string
  error?: string
}

type CacheRow = {
  bdl_game_id: number
  game_date: string
  home_team: string
  away_team: string
  stadium: string | null
  lat: number | null
  lon: number | null
  game_start_utc: string | null
  snapshot_time_utc: string | null
  temp_f: number | null
  humidity_pct: number | null
  wind_speed_mph: number | null
  wind_deg: number | null
  weather_main: string | null
  weather_description: string | null
  source: string
  payload: Record<string, unknown>
  fetched_at: string
}

type BdlGameWeatherRow = {
  bdl_game_id: number
  date: string
  start_time_utc: string | null
  home_team_abbrev: string
  away_team_abbrev: string
}

function hourlyToIso(hourlyDt: number | null | undefined): string | null {
  if (hourlyDt == null || !Number.isFinite(hourlyDt)) return null
  return new Date(hourlyDt * 1000).toISOString()
}

function pickBestHourly(payload: OneCallPayload, gameStartUtc: string | null | undefined) {
  const hours = payload.hourly ?? []
  if (!hours.length || !gameStartUtc) return null
  const target = new Date(gameStartUtc).getTime()
  if (Number.isNaN(target)) return null

  let best: (typeof hours)[number] | null = null
  let bestDiff = Number.POSITIVE_INFINITY
  for (const h of hours) {
    const dt = h.dt != null ? h.dt * 1000 : Number.NaN
    if (Number.isNaN(dt)) continue
    const diff = Math.abs(dt - target)
    if (diff < bestDiff) {
      bestDiff = diff
      best = h
    }
  }
  return best
}

/** First pitch time for this home team on the calendar date (for hourly pick). */
export async function getGameStartUtcForHomeTeam(
  supabase: SupabaseClient,
  dateIso: string,
  homeNorm: string,
): Promise<string | null> {
  const { data: games } = await supabase
    .from('bdl_games')
    .select('start_time_utc,home_team_abbrev')
    .eq('date', dateIso)

  const matches: string[] = []
  for (const g of (games ?? []) as { start_time_utc: string | null; home_team_abbrev: string }[]) {
    const h = normalizeMlbHomeTeam(g.home_team_abbrev)
    if (h === homeNorm && g.start_time_utc) matches.push(g.start_time_utc)
  }
  if (!matches.length) return null
  matches.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
  return matches[0] ?? null
}

function chosenSliceToCurrentPayload(
  payload: OneCallPayload,
  gameStartUtc: string | null,
): { weather: OneCallPayload; snapshot_time_utc: string | null } {
  const chosen = pickBestHourly(payload, gameStartUtc) ?? payload.current ?? null
  if (!chosen) {
    throw new Error('OpenWeather payload has no current or hourly data')
  }
  const dt = (chosen as { dt?: number }).dt
  const snapshot_time_utc = dt != null ? hourlyToIso(dt) : null
  const current = {
    temp: chosen.temp,
    feels_like: chosen.feels_like,
    humidity: chosen.humidity,
    wind_speed: chosen.wind_speed,
    wind_deg: chosen.wind_deg,
    weather: chosen.weather,
  }
  return {
    weather: {
      lat: payload.lat,
      lon: payload.lon,
      current,
    },
    snapshot_time_utc,
  }
}

/**
 * Fetch weather at the home ballpark by coordinates (and optional first-pitch time from bdl_games).
 * Does not depend on game_weather_cache or successful syncWeatherForDate.
 */
export async function fetchWeatherForHomeStadium(
  supabase: SupabaseClient,
  dateIso: string,
  homeAbbrevRaw: string,
): Promise<StadiumWeatherSlateEntry> {
  const park = getBallparkForHomeTeam(homeAbbrevRaw)
  const norm = normalizeMlbHomeTeam(homeAbbrevRaw)
  if (!park || !norm) {
    return { home_team: norm, stadium: null, error: 'unknown_team' }
  }
  try {
    const gameStartUtc = await getGameStartUtcForHomeTeam(supabase, dateIso, norm)
    const payload = await fetchOneCallWeather(park.lat, park.lon)
    const { weather, snapshot_time_utc } = chosenSliceToCurrentPayload(payload, gameStartUtc)
    return {
      home_team: norm,
      stadium: park.stadium,
      lat: weather.lat,
      lon: weather.lon,
      weather,
      game_start_utc: gameStartUtc,
      snapshot_time_utc,
      fetched_at: new Date().toISOString(),
      source: 'openweather_stadium',
    }
  } catch (e) {
    return {
      home_team: norm,
      stadium: park.stadium,
      lat: park.lat,
      lon: park.lon,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/** Parallel slate: one OpenWeather call per unique home (in-memory lat/lon dedupe in fetchOneCallWeather). */
export async function fetchWeatherSlateEntriesForHomes(
  supabase: SupabaseClient,
  dateIso: string,
  homeAbbrevs: string[],
): Promise<StadiumWeatherSlateEntry[]> {
  const unique = [...new Set(homeAbbrevs)]
  return Promise.all(unique.map((h) => fetchWeatherForHomeStadium(supabase, dateIso, h)))
}

function buildCacheRow(game: BdlGameWeatherRow, payload: OneCallPayload): CacheRow {
  const park = getBallparkForHomeTeam(game.home_team_abbrev)
  const chosen = pickBestHourly(payload, game.start_time_utc) ?? payload.current ?? null
  const weather0 = chosen?.weather?.[0]

  return {
    bdl_game_id: game.bdl_game_id,
    game_date: game.date,
    home_team: normalizeMlbHomeTeam(game.home_team_abbrev) ?? game.home_team_abbrev,
    away_team: normalizeMlbHomeTeam(game.away_team_abbrev) ?? game.away_team_abbrev,
    stadium: park?.stadium ?? null,
    lat: payload.lat,
    lon: payload.lon,
    game_start_utc: game.start_time_utc,
    snapshot_time_utc: 'dt' in (chosen ?? {}) ? hourlyToIso((chosen as { dt?: number }).dt) : null,
    temp_f: chosen?.temp ?? null,
    humidity_pct: chosen?.humidity ?? null,
    wind_speed_mph: chosen?.wind_speed ?? null,
    wind_deg: chosen?.wind_deg ?? null,
    weather_main: weather0?.main ?? null,
    weather_description: weather0?.description ?? null,
    source: 'openweather_hourly',
    payload: payload as unknown as Record<string, unknown>,
    fetched_at: new Date().toISOString(),
  }
}

export async function listCachedWeatherForDate(
  supabase: SupabaseClient,
  dateIso: string,
): Promise<CacheRow[]> {
  const { data } = await supabase
    .from('game_weather_cache')
    .select('*')
    .eq('game_date', dateIso)
    .order('game_start_utc', { ascending: true })

  return (data ?? []) as CacheRow[]
}

export async function syncWeatherForDate(
  supabase: SupabaseClient,
  dateIso: string,
  opts?: { force?: boolean },
): Promise<{ synced: number; cached: number; errors: string[] }> {
  const force = opts?.force === true
  const { data: games } = await supabase
    .from('bdl_games')
    .select('bdl_game_id,date,start_time_utc,home_team_abbrev,away_team_abbrev')
    .eq('date', dateIso)
    .order('start_time_utc', { ascending: true })

  const rows = (games ?? []) as BdlGameWeatherRow[]
  if (!rows.length) return { synced: 0, cached: 0, errors: [] }

  const existing = force
    ? new Set<number>()
    : new Set(
        (
          await supabase
            .from('game_weather_cache')
            .select('bdl_game_id')
            .eq('game_date', dateIso)
        ).data?.map((r: any) => Number(r.bdl_game_id)) ?? [],
      )

  let synced = 0
  let cached = 0
  const errors: string[] = []

  const results = await Promise.all(
    rows.map(async (game) => {
      if (!force && existing.has(game.bdl_game_id)) {
        return { kind: 'cached' as const }
      }

      const park = getBallparkForHomeTeam(game.home_team_abbrev)
      if (!park) {
        return { kind: 'error' as const, msg: `${game.home_team_abbrev}: unknown ballpark` }
      }

      try {
        const payload = await fetchOneCallWeather(park.lat, park.lon)
        const row = buildCacheRow(game, payload)
        const { error } = await supabase
          .from('game_weather_cache')
          .upsert(row, { onConflict: 'bdl_game_id' })
        if (error) {
          return { kind: 'error' as const, msg: `${game.home_team_abbrev}: ${error.message}` }
        }
        return { kind: 'synced' as const }
      } catch (e) {
        return {
          kind: 'error' as const,
          msg: `${game.home_team_abbrev}: ${e instanceof Error ? e.message : String(e)}`,
        }
      }
    }),
  )

  for (const r of results) {
    if (r.kind === 'cached') cached++
    else if (r.kind === 'synced') synced++
    else errors.push(r.msg)
  }

  return { synced, cached, errors }
}
