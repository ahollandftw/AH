import type { Express } from 'express'
import { config } from '../config.js'
import { getServiceClient } from '../supabase.js'
import { getBallparkForHomeTeam, normalizeMlbHomeTeam } from '../weather/mlbBallparks.js'
import { type OneCallPayload } from '../weather/openWeather.js'
import {
  fetchWeatherForHomeStadium,
  fetchWeatherSlateEntriesForHomes,
} from '../weather/cache.js'

function todayET(): string {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

export function registerWeatherRoutes(app: Express) {
  /** Single ballpark/game-date weather: ?home_team=ATL&date=2026-03-27 */
  app.get('/bdl/weather', async (req, res) => {
    try {
      const home = String(req.query.home_team ?? '').trim()
      const date = String(req.query.date ?? todayET()).trim()
      if (!home) {
        res.status(400).json({ error: 'home_team required' })
        return
      }
      const park = getBallparkForHomeTeam(home)
      if (!park) {
        res.status(404).json({ error: 'Unknown home_team ballpark' })
        return
      }
      if (!config.openWeatherApiKey()) {
        res.json({
          ok: false,
          home_team: normalizeMlbHomeTeam(home),
          stadium: park.stadium,
          lat: park.lat,
          lon: park.lon,
          error: 'OPENWEATHER_API_KEY not configured',
        })
        return
      }
      const sb = getServiceClient()
      const entry = await fetchWeatherForHomeStadium(sb, date, home)
      if (entry.error || !entry.weather) {
        res.json({
          ok: false,
          home_team: entry.home_team ?? normalizeMlbHomeTeam(home),
          stadium: entry.stadium ?? park.stadium,
          lat: entry.lat ?? park.lat,
          lon: entry.lon ?? park.lon,
          error: entry.error ?? 'Weather unavailable',
        })
        return
      }
      res.json({
        ok: true,
        date,
        home_team: entry.home_team,
        stadium: entry.stadium,
        lat: entry.lat,
        lon: entry.lon,
        weather: entry.weather,
        game_start_utc: entry.game_start_utc,
        snapshot_time_utc: entry.snapshot_time_utc,
        fetched_at: entry.fetched_at,
        source: entry.source,
      })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  /** Batch by home teams on the slate: ?homes=ATL,NYM,KCR&date=2026-03-27 */
  app.get('/bdl/weather/slate', async (req, res) => {
    try {
      const homesRaw = String(req.query.homes ?? '').trim()
      const date = String(req.query.date ?? todayET()).trim()
      if (!homesRaw) {
        res.status(400).json({
          error: 'homes required (comma-separated home abbrevs, e.g. ATL,NYM)',
        })
        return
      }
      const rawList = homesRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const unique = [...new Set(rawList)]
      const sb = getServiceClient()

      if (!config.openWeatherApiKey()) {
        const entries: WeatherSlateEntry[] = unique.map((h) => {
          const park = getBallparkForHomeTeam(h)
          const norm = normalizeMlbHomeTeam(h)
          if (!park) return { home_team: norm, stadium: null, error: 'unknown_team' }
          return {
            home_team: norm,
            stadium: park.stadium,
            lat: park.lat,
            lon: park.lon,
            error: 'OPENWEATHER_API_KEY not configured',
          }
        })
        res.json({ ok: true, entries })
        return
      }

      const entries = await fetchWeatherSlateEntriesForHomes(sb, date, unique)
      res.json({ ok: true, entries })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })
}

type WeatherSlateEntry = {
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
