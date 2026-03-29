import type { Express } from 'express'
import { config } from '../config.js'
import { getServiceClient } from '../supabase.js'
import { getBallparkForHomeTeam, normalizeMlbHomeTeam } from '../weather/mlbBallparks.js'
import { type OneCallPayload } from '../weather/openWeather.js'
import { listCachedWeatherForDate, syncWeatherForDate } from '../weather/cache.js'

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
      const syncResult = await syncWeatherForDate(sb, date)
      const rows = await listCachedWeatherForDate(sb, date)
      const match = rows.find((r) => r.home_team === (normalizeMlbHomeTeam(home) ?? home))
      if (!match) {
        res.json({
          ok: false,
          home_team: normalizeMlbHomeTeam(home),
          stadium: park.stadium,
          lat: park.lat,
          lon: park.lon,
          error: 'No cached weather found for date',
          sync_errors: syncResult.errors,
        })
        return
      }
      res.json({
        ok: true,
        date,
        home_team: normalizeMlbHomeTeam(home),
        stadium: park.stadium,
        lat: match.lat,
        lon: match.lon,
        weather: {
          lat: Number(match.lat ?? park.lat),
          lon: Number(match.lon ?? park.lon),
          current: {
            temp: Number(match.temp_f ?? 0),
            humidity: Number(match.humidity_pct ?? 0),
            wind_speed: Number(match.wind_speed_mph ?? 0),
            wind_deg: Number(match.wind_deg ?? 0),
            weather: [
              {
                main: match.weather_main ?? undefined,
                description: match.weather_description ?? undefined,
              },
            ],
          },
        },
        game_start_utc: match.game_start_utc,
        snapshot_time_utc: match.snapshot_time_utc,
        fetched_at: match.fetched_at,
        source: match.source,
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
      let syncResult: Awaited<ReturnType<typeof syncWeatherForDate>> | null = null

      if (config.openWeatherApiKey()) {
        syncResult = await syncWeatherForDate(sb, date)
      }
      const cached = await listCachedWeatherForDate(sb, date)

      const tasks = unique.map(async (h): Promise<WeatherSlateEntry> => {
        const park = getBallparkForHomeTeam(h)
        const norm = normalizeMlbHomeTeam(h)
        if (!park) {
          return { home_team: norm, stadium: null, error: 'unknown_team' }
        }
        if (!config.openWeatherApiKey()) {
          return {
            home_team: norm,
            stadium: park.stadium,
            lat: park.lat,
            lon: park.lon,
            error: 'OPENWEATHER_API_KEY not configured',
          }
        }
        try {
          const match = cached.find((r) => r.home_team === norm)
          if (!match) {
            return {
              home_team: norm,
              stadium: park.stadium,
              lat: park.lat,
              lon: park.lon,
              error: 'No cached weather found for date',
              sync_errors: syncResult?.errors,
            }
          }
          return {
            home_team: norm,
            stadium: match.stadium ?? park.stadium,
            lat: Number(match.lat ?? park.lat),
            lon: Number(match.lon ?? park.lon),
            weather: {
              lat: Number(match.lat ?? park.lat),
              lon: Number(match.lon ?? park.lon),
              current: {
                temp: Number(match.temp_f ?? 0),
                humidity: Number(match.humidity_pct ?? 0),
                wind_speed: Number(match.wind_speed_mph ?? 0),
                wind_deg: Number(match.wind_deg ?? 0),
                weather: [
                  {
                    main: match.weather_main ?? undefined,
                    description: match.weather_description ?? undefined,
                  },
                ],
              },
            },
            game_start_utc: match.game_start_utc,
            snapshot_time_utc: match.snapshot_time_utc,
            fetched_at: match.fetched_at,
            source: match.source,
          }
        } catch (err) {
          return {
            home_team: norm,
            stadium: park.stadium,
            error: String(err),
          }
        }
      })

      const entries = await Promise.all(tasks)
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
  sync_errors?: string[]
}
