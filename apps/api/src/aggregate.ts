import type { PlayerStatsDailyRow } from './types.js'
import { getServiceClient } from './supabase.js'
import { config } from './config.js'

type Daily = {
  date: string
  plate_appearances: number
  home_runs: number
  barrels: number
  barrel_rate: number | null
  hard_hit_rate: number | null
  avg_exit_velo: number | null
  fly_ball_rate: number | null
}

function parseIso(d: string): number {
  return new Date(d + 'T12:00:00Z').getTime()
}

/** Last `days` calendar dates ending at `end` (UTC date strings). */
function dayStringsEnding(end: Date, days: number): Set<string> {
  const s = new Set<string>()
  for (let i = 0; i < days; i++) {
    const d = new Date(end)
    d.setUTCDate(d.getUTCDate() - i)
    s.add(d.toISOString().slice(0, 10))
  }
  return s
}

function sumWindow(rows: Daily[], days: number, end: Date): Daily[] {
  const ds = dayStringsEnding(end, days)
  return rows.filter((r) => ds.has(r.date))
}

function weightedRate(
  slice: Daily[],
  pick: (d: Daily) => number | null,
): number | null {
  let num = 0
  let den = 0
  for (const d of slice) {
    const pa = d.plate_appearances || 0
    if (pa <= 0) continue
    const v = pick(d)
    if (v == null || Number.isNaN(v)) continue
    num += v * pa
    den += pa
  }
  return den > 0 ? num / den : null
}

function sumBarrelsPa(slice: Daily[]): { barrels: number; pa: number; hr: number } {
  let barrels = 0
  let pa = 0
  let hr = 0
  for (const d of slice) {
    barrels += d.barrels || 0
    pa += d.plate_appearances || 0
    hr += d.home_runs || 0
  }
  return { barrels, pa, hr }
}

function norm(
  v: number,
  min: number,
  max: number,
): number {
  if (max <= min) return 0.5
  return (v - min) / (max - min)
}

/**
 * Recomputes player_aggregates from player_stats_daily for the current season window.
 */
export async function runAggregation(): Promise<{ updated: number; last_updated: string }> {
  const supabase = getServiceClient()
  const seasonStart = config.seasonStart()
  const today = new Date()
  today.setHours(23, 59, 59, 999)

  const { data: raw, error } = await supabase
    .from('player_stats_daily')
    .select(
      'player_id, player_name, team, position, date, plate_appearances, home_runs, barrels, barrel_rate, hard_hit_rate, avg_exit_velo, fly_ball_rate',
    )
    .gte('date', seasonStart)
    .lte('date', today.toISOString().slice(0, 10))

  if (error) throw error
  const rows = (raw ?? []) as PlayerStatsDailyRow[]

  const byPlayer = new Map<number, Daily[]>()
  const meta = new Map<number, { player_name: string | null; team: string | null; position: string | null }>()

  for (const r of rows) {
    const id = r.player_id
    if (!byPlayer.has(id)) byPlayer.set(id, [])
    byPlayer.get(id)!.push({
      date: r.date,
      plate_appearances: r.plate_appearances ?? 0,
      home_runs: r.home_runs ?? 0,
      barrels: r.barrels ?? 0,
      barrel_rate: r.barrel_rate,
      hard_hit_rate: r.hard_hit_rate,
      avg_exit_velo: r.avg_exit_velo,
      fly_ball_rate: r.fly_ball_rate,
    })
    meta.set(id, { player_name: r.player_name, team: r.team, position: r.position })
  }

  for (const arr of byPlayer.values()) {
    arr.sort((a, b) => parseIso(a.date) - parseIso(b.date))
  }

  let leaguePa = 0
  let leagueHr = 0
  let leagueBarrels = 0
  for (const arr of byPlayer.values()) {
    for (const d of arr) {
      leaguePa += d.plate_appearances || 0
      leagueHr += d.home_runs || 0
      leagueBarrels += d.barrels || 0
    }
  }
  const leagueAvgBarrelRate = leaguePa > 0 ? leagueBarrels / leaguePa : null
  const leagueHrPerPa = leaguePa > 0 ? leagueHr / leaguePa : 0

  const end = today
  const metrics: {
    player_id: number
    last3_br: number | null
    last7_br: number | null
    last14_br: number | null
    season_br: number | null
    last7_hh: number | null
    last7_ev: number | null
    last7_fb: number | null
    last7_pa: number
    season_pa: number
    season_hr: number
    barrel_plus: number | null
  }[] = []

  for (const [pid, arr] of byPlayer) {
    const w3 = sumWindow(arr, 3, end)
    const w7 = sumWindow(arr, 7, end)
    const w14 = sumWindow(arr, 14, end)

    const s3 = sumBarrelsPa(w3)
    const s7 = sumBarrelsPa(w7)
    const s14 = sumBarrelsPa(w14)
    const season = sumBarrelsPa(arr)

    const last3_br = s3.pa > 0 ? s3.barrels / s3.pa : null
    const last7_br = s7.pa > 0 ? s7.barrels / s7.pa : null
    const last14_br = s14.pa > 0 ? s14.barrels / s14.pa : null
    const season_br = season.pa > 0 ? season.barrels / season.pa : null

    const last7_hh = weightedRate(w7, (d) => d.hard_hit_rate)
    const last7_ev = weightedRate(w7, (d) => d.avg_exit_velo)
    const last7_fb = weightedRate(w7, (d) => d.fly_ball_rate)

    const barrel_plus =
      leagueAvgBarrelRate != null && leagueAvgBarrelRate > 0 && last7_br != null
        ? last7_br / leagueAvgBarrelRate
        : null

    metrics.push({
      player_id: pid,
      last3_br: last3_br,
      last7_br: last7_br,
      last14_br: last14_br,
      season_br: season_br,
      last7_hh: last7_hh,
      last7_ev: last7_ev,
      last7_fb: last7_fb,
      last7_pa: s7.pa,
      season_pa: season.pa,
      season_hr: season.hr,
      barrel_plus,
    })
  }

  const brs = metrics.map((m) => m.last7_br).filter((x): x is number => x != null && !Number.isNaN(x))
  const hhs = metrics.map((m) => m.last7_hh).filter((x): x is number => x != null && !Number.isNaN(x))
  const evs = metrics.map((m) => m.last7_ev).filter((x): x is number => x != null && !Number.isNaN(x))
  const fbs = metrics.map((m) => m.last7_fb).filter((x): x is number => x != null && !Number.isNaN(x))

  const minBr = brs.length ? Math.min(...brs) : 0
  const maxBr = brs.length ? Math.max(...brs) : 1
  const minHh = hhs.length ? Math.min(...hhs) : 0
  const maxHh = hhs.length ? Math.max(...hhs) : 1
  const minEv = evs.length ? Math.min(...evs) : 0
  const maxEv = evs.length ? Math.max(...evs) : 1
  const minFb = fbs.length ? Math.min(...fbs) : 0
  const maxFb = fbs.length ? Math.max(...fbs) : 1

  const last_updated = new Date().toISOString()
  const upserts: Record<string, unknown>[] = []

  for (const m of metrics) {
    const pl = meta.get(m.player_id)
    const nBr = m.last7_br != null ? norm(m.last7_br, minBr, maxBr) : 0.5
    const nHh = m.last7_hh != null ? norm(m.last7_hh, minHh, maxHh) : 0.5
    const nEv = m.last7_ev != null ? norm(m.last7_ev, minEv, maxEv) : 0.5
    const nFb = m.last7_fb != null ? norm(m.last7_fb, minFb, maxFb) : 0.5

    const hr_score =
      nBr * 0.4 + nHh * 0.25 + nEv * 0.2 + nFb * 0.15

    const expected_hr = leagueHrPerPa * m.season_pa
    const actual_hr = m.season_hr
    const hr_diff = actual_hr - expected_hr
    const low_sample = m.last7_pa < 10

    upserts.push({
      player_id: m.player_id,
      player_name: pl?.player_name ?? null,
      team: pl?.team ?? null,
      position: pl?.position ?? null,
      sample_size_pa: m.last7_pa,
      last3_barrel_rate: m.last3_br,
      last7_barrel_rate: m.last7_br,
      last14_barrel_rate: m.last14_br,
      season_barrel_rate: m.season_br,
      last7_hard_hit_rate: m.last7_hh,
      last7_avg_exit_velo: m.last7_ev,
      hr_score,
      expected_hr,
      actual_hr,
      hr_diff,
      low_sample,
      league_avg_barrel_rate: leagueAvgBarrelRate,
      barrel_plus: m.barrel_plus,
      updated_at: last_updated,
    })
  }

  if (upserts.length === 0) {
    return { updated: 0, last_updated }
  }

  const { error: upErr } = await supabase.from('player_aggregates').upsert(upserts, {
    onConflict: 'player_id',
  })
  if (upErr) throw upErr

  return { updated: upserts.length, last_updated }
}
