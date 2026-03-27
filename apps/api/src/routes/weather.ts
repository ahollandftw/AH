import type { Express } from 'express'
import { config } from '../config.js'
import { getBallparkForHomeTeam, normalizeMlbHomeTeam } from '../weather/mlbBallparks.js'
import { fetchOneCallWeather, type OneCallPayload } from '../weather/openWeather.js'

export function registerWeatherRoutes(app: Express) {
  /** Single ballpark: ?home_team=ATL */
  app.get('/bdl/weather', async (req, res) => {
    try {
      if (!config.openWeatherApiKey()) {
        res.status(503).json({ error: 'Weather not configured (OPENWEATHER_API_KEY)' })
        return
      }
      const home = String(req.query.home_team ?? '').trim()
      if (!home) {
        res.status(400).json({ error: 'home_team required' })
        return
      }
      const park = getBallparkForHomeTeam(home)
      if (!park) {
        res.status(404).json({ error: 'Unknown home_team ballpark' })
        return
      }
      const weather = await fetchOneCallWeather(park.lat, park.lon)
      res.json({
        ok: true,
        home_team: normalizeMlbHomeTeam(home),
        stadium: park.stadium,
        lat: park.lat,
        lon: park.lon,
        weather,
      })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  /** Batch by home teams on the slate: ?homes=ATL,NYM,KCR */
  app.get('/bdl/weather/slate', async (req, res) => {
    try {
      if (!config.openWeatherApiKey()) {
        res.status(503).json({ error: 'Weather not configured (OPENWEATHER_API_KEY)' })
        return
      }
      const homesRaw = String(req.query.homes ?? '').trim()
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

      const tasks = unique.map(async (h): Promise<WeatherSlateEntry> => {
        const park = getBallparkForHomeTeam(h)
        const norm = normalizeMlbHomeTeam(h)
        if (!park) {
          return { home_team: norm, stadium: null, error: 'unknown_team' }
        }
        try {
          const weather = await fetchOneCallWeather(park.lat, park.lon)
          return {
            home_team: norm,
            stadium: park.stadium,
            lat: park.lat,
            lon: park.lon,
            weather,
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
  error?: string
}
