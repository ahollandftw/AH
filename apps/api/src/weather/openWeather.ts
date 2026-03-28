import { config } from '../config.js'

const ONE_CALL_BASE = 'https://api.openweathermap.org/data/3.0/onecall'
const CACHE_TTL_MS = 10 * 60 * 1000

type CacheEntry = { at: number; payload: OneCallPayload }

const cache = new Map<string, CacheEntry>()

export type OneCallPayload = {
  lat: number
  lon: number
  timezone?: string
  timezone_offset?: number
  current?: {
    dt?: number
    temp?: number
    feels_like?: number
    humidity?: number
    wind_speed?: number
    wind_deg?: number
    weather?: Array<{ id?: number; main?: string; description?: string; icon?: string }>
  }
  hourly?: Array<{
    dt?: number
    temp?: number
    feels_like?: number
    humidity?: number
    wind_speed?: number
    wind_deg?: number
    weather?: Array<{ id?: number; main?: string; description?: string; icon?: string }>
  }>
}

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`
}

export async function fetchOneCallWeather(lat: number, lon: number): Promise<OneCallPayload> {
  const key = cacheKey(lat, lon)
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.payload
  }

  const apiKey = config.openWeatherApiKey()
  if (!apiKey) {
    throw new Error('OPENWEATHER_API_KEY is not configured')
  }

  const url = new URL(ONE_CALL_BASE)
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lon', String(lon))
  url.searchParams.set('exclude', 'minutely,daily,alerts')
  url.searchParams.set('units', 'imperial')
  url.searchParams.set('appid', apiKey)

  const res = await fetch(url.toString())
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenWeather ${res.status}: ${body}`)
  }

  const raw = (await res.json()) as Record<string, unknown>
  const payload: OneCallPayload = {
    lat,
    lon,
    timezone: raw.timezone as string | undefined,
    timezone_offset: raw.timezone_offset as number | undefined,
    current: raw.current as OneCallPayload['current'],
    hourly: raw.hourly as OneCallPayload['hourly'],
  }

  cache.set(key, { at: now, payload })
  return payload
}
