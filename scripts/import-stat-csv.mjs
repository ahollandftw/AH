/**
 * Upserts players + stats from data/*.csv into Supabase.
 * Env (repo root .env or process env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY  — never ship to clients
 *
 * Usage: npm run import:stats
 */

import { parse } from 'csv-parse/sync'
import { config } from 'dotenv'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

// Load in order; later files do not override earlier keys unless we used override: true (we don't).
config({ path: path.join(root, '.env') })
config({ path: path.join(root, '.env.local') })
config({ path: path.join(root, 'apps', 'web', '.env') })
config({ path: path.join(root, 'apps', 'mobile', '.env') })

const url =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.EXPO_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!key) {
  console.error(`
Missing SUPABASE_SERVICE_ROLE_KEY (server-only secret).

Add a repo-root .env file (do not commit it) with:

  SUPABASE_SERVICE_ROLE_KEY=<Project Settings → API → service_role key>

Optional:
  SUPABASE_URL=<your project URL>

If you omit SUPABASE_URL, this script uses VITE_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_URL from apps/web or apps/mobile .env.
`)
  process.exit(1)
}

if (!url) {
  console.error(
    'Missing project URL: set SUPABASE_URL or add VITE_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_URL in apps/web or apps/mobile .env',
  )
  process.exit(1)
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** Excel / some exports prefix UTF-8 BOM; csv-parse treats it as a bad quote without this. */
function readCsvUtf8(filePath) {
  let s = fs.readFileSync(filePath, 'utf8')
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  return s
}

const csvParseOpts = {
  columns: true,
  skip_empty_lines: true,
  relax_column_count: true,
  bom: true,
}

function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return s || 'player'
}

function num(v) {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function int(v) {
  const n = num(v)
  return n == null ? null : Math.trunc(n)
}

async function upsertPlayerFromRow(displayName, statPlayerId, team) {
  const sid = String(statPlayerId).trim()
  if (!/^\d+$/.test(sid)) return
  const name = String(displayName || '').trim() || `Player ${sid}`
  const slug = `${slugify(name)}-${sid}`
  const { error } = await supabase.from('players').upsert(
    {
      stat_player_id: sid,
      name,
      slug,
      team: team ? String(team).trim() : null,
      position: null,
      image_url: null,
    },
    { onConflict: 'stat_player_id' },
  )
  if (error) console.error('players upsert', sid, error.message)
}

function parseFilename(file) {
  const base = path.basename(file, '.csv')
  const yearMatch = base.match(/(20\d{2})/)
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null
  const isBatting = base.startsWith('b.')
  const isPitching = base.startsWith('p.')
  const role = isBatting ? 'batting' : isPitching ? 'pitching' : null
  let kind = null
  if (base.includes('homeruns')) kind = 'homeruns'
  else if (base.includes('exit_velocity')) kind = 'exit_velocity'
  else if (base.includes('pitch-arsenal-stats')) kind = 'pitch_arsenal'
  else if (base.includes('standard2019through2025')) kind = 'standard'
  return { base, role, kind, year }
}

async function importHomeruns(file, role, year) {
  const raw = readCsvUtf8(file)
  const rows = parse(raw, csvParseOpts)
  const batch = []
  for (const r of rows) {
    const pid = r.player_id
    const y = int(r.year) ?? year
    if (y == null) continue
    await upsertPlayerFromRow(r.player, pid, r.team_abbrev)
    batch.push({
      role,
      player_id: String(pid).trim(),
      player_display: r.player ?? null,
      team_abbrev: r.team_abbrev ?? null,
      year: y,
      type: r.type ?? '',
      avg_hr_trot: num(r.avg_hr_trot),
      doubters: int(r.doubters),
      mostly_gone: int(r.mostly_gone),
      no_doubters: int(r.no_doubters),
      no_doubter_per: num(r.no_doubter_per),
      hr_total: int(r.hr_total),
      xhr: num(r.xhr),
      xhr_diff: num(r.xhr_diff),
    })
  }
  const chunkSize = 200
  for (let i = 0; i < batch.length; i += chunkSize) {
    const part = batch.slice(i, i + chunkSize)
    const { error } = await supabase.from('stats_homeruns').upsert(part, {
      onConflict: 'role,player_id,year,type',
    })
    if (error) console.error('stats_homeruns', file, error.message)
  }
  console.log(`homeruns ${path.basename(file)}: ${batch.length} rows`)
}

async function importExitVelocity(file, role, season) {
  const raw = readCsvUtf8(file)
  const rows = parse(raw, csvParseOpts)
  const batch = []
  for (const r of rows) {
    const pid = r.player_id
    await upsertPlayerFromRow(r['last_name, first_name'] ?? r.last_name_first_name, pid, null)
    batch.push({
      role,
      player_id: String(pid).trim(),
      season,
      last_name_first_name: r['last_name, first_name'] ?? r.last_name_first_name ?? null,
      attempts: int(r.attempts),
      avg_hit_angle: num(r.avg_hit_angle),
      anglesweetspotpercent: num(r.anglesweetspotpercent),
      max_hit_speed: num(r.max_hit_speed),
      avg_hit_speed: num(r.avg_hit_speed),
      ev50: num(r.ev50),
      fbld: num(r.fbld),
      gb: num(r.gb),
      max_distance: int(r.max_distance),
      avg_distance: int(r.avg_distance),
      avg_hr_distance: int(r.avg_hr_distance),
      ev95plus: int(r.ev95plus),
      ev95percent: num(r.ev95percent),
      barrels: int(r.barrels),
      brl_percent: num(r.brl_percent),
      brl_pa: num(r.brl_pa),
    })
  }
  const chunkSize = 200
  for (let i = 0; i < batch.length; i += chunkSize) {
    const part = batch.slice(i, i + chunkSize)
    const { error } = await supabase.from('stats_exit_velocity').upsert(part, {
      onConflict: 'role,player_id,season',
    })
    if (error) console.error('stats_exit_velocity', file, error.message)
  }
  console.log(`exit_velocity ${path.basename(file)}: ${batch.length} rows`)
}

async function importPitchArsenal(file, role, season) {
  const raw = readCsvUtf8(file)
  const rows = parse(raw, csvParseOpts)
  const batch = []
  for (const r of rows) {
    const pid = r.player_id
    await upsertPlayerFromRow(r['last_name, first_name'] ?? r.last_name_first_name, pid, r.team_name_alt)
    batch.push({
      role,
      player_id: String(pid).trim(),
      season,
      last_name_first_name: r['last_name, first_name'] ?? r.last_name_first_name ?? null,
      team_name_alt: r.team_name_alt ?? null,
      pitch_type: r.pitch_type ?? '',
      pitch_name: r.pitch_name ?? '',
      run_value_per_100: num(r.run_value_per_100),
      run_value: num(r.run_value),
      pitches: int(r.pitches),
      pitch_usage: num(r.pitch_usage),
      pa: int(r.pa),
      ba: num(r.ba),
      slg: num(r.slg),
      woba: num(r.woba),
      whiff_percent: num(r.whiff_percent),
      k_percent: num(r.k_percent),
      put_away: num(r.put_away),
      est_ba: num(r.est_ba),
      est_slg: num(r.est_slg),
      est_woba: num(r.est_woba),
      hard_hit_percent: num(r.hard_hit_percent),
    })
  }
  const chunkSize = 150
  for (let i = 0; i < batch.length; i += chunkSize) {
    const part = batch.slice(i, i + chunkSize)
    const { error } = await supabase.from('stats_pitch_arsenal').upsert(part, {
      onConflict: 'role,player_id,season,pitch_type,pitch_name',
    })
    if (error) console.error('stats_pitch_arsenal', file, error.message)
  }
  console.log(`pitch_arsenal ${path.basename(file)}: ${batch.length} rows`)
}

async function importSchedule(file) {
  const raw = readCsvUtf8(file)
  const rows = parse(raw, csvParseOpts)
  const batch = rows.map((r) => ({
    game_id: r.game_id,
    slate_id: r.slate_id ?? null,
    date: r.date,
    day_of_week: r.day_of_week ?? null,
    slate_type: r.slate_type ?? null,
    games_on_date: int(r.games_on_date),
    home_team: r.home_team,
    away_team: r.away_team,
    home_league: r.home_league ?? null,
    away_league: r.away_league ?? null,
    interleague: r.interleague === 'True',
    neutral_site: r.neutral_site === 'True',
    doubleheader: r.doubleheader === 'True',
  }))
  const chunkSize = 200
  for (let i = 0; i < batch.length; i += chunkSize) {
    const part = batch.slice(i, i + chunkSize)
    const { error } = await supabase
      .from('schedule_games')
      .upsert(part, { onConflict: 'game_id' })
    if (error) console.error('schedule_games', file, error.message)
  }
  console.log(`schedule ${path.basename(file)}: ${batch.length} rows`)
}

/** e.g. b.battedballvLHP2019through2025 → batting + vs_lhp */
function parseBattedBallFile(base) {
  const m = base.match(/^(b|p)\.battedballv(LHP|RHP|LHH|RHH)/i)
  if (!m) return null
  const role = m[1].toLowerCase() === 'b' ? 'batting' : 'pitching'
  const vs = m[2].toUpperCase()
  const split = { LHP: 'vs_lhp', RHP: 'vs_rhp', LHH: 'vs_lhh', RHH: 'vs_rhh' }[vs]
  return split ? { role, split } : null
}

async function importParkFactors(file, scope) {
  const raw = readCsvUtf8(file)
  const rows = parse(raw, csvParseOpts)
  const batch = []
  for (const r of rows) {
    const venue = String(r.Venue ?? '').trim()
    if (!venue) continue
    const yearLabel = String(r.Year ?? '').trim()
    const metrics = {}
    for (const [k, v] of Object.entries(r)) {
      if (['Rk.', 'Team', 'Venue', 'Year', 'Park Factor'].includes(k)) continue
      const n = num(v)
      metrics[k] = n !== null ? n : v
    }
    batch.push({
      scope,
      rk: int(r['Rk.']),
      team: String(r.Team ?? '').trim(),
      venue,
      year_label: yearLabel,
      park_factor: int(r['Park Factor']),
      metrics,
    })
  }
  const chunkSize = 50
  for (let i = 0; i < batch.length; i += chunkSize) {
    const part = batch.slice(i, i + chunkSize)
    const { error } = await supabase.from('stats_park_factors').upsert(part, {
      onConflict: 'scope,venue,year_label',
    })
    if (error) console.error('stats_park_factors', file, error.message)
  }
  console.log(`park_factors ${scope} ${path.basename(file)}: ${batch.length} rows`)
}

async function importBattedBall(file, role, split) {
  const raw = readCsvUtf8(file)
  const rows = parse(raw, csvParseOpts)
  const batch = []
  for (const r of rows) {
    const pid = String(r.player_id ?? r.PlayerId ?? '').trim()
    if (!/^\d+$/.test(pid)) continue
    await upsertPlayerFromRow(r.Name, pid, r.Team)
    const metrics = { ...r }
    delete metrics.Name
    delete metrics.Team
    delete metrics.PlayerId
    delete metrics.player_id
    delete metrics.NameASCII
    delete metrics.MLBAMID
    for (const k of Object.keys(metrics)) {
      const v = metrics[k]
      if (v != null && v !== '' && typeof v === 'string') {
        const n = num(v)
        if (n !== null) metrics[k] = n
      }
    }
    batch.push({
      role,
      split,
      player_id: pid,
      player_name: r.Name ?? null,
      team: r.Team ?? null,
      mlbam_id: int(r.MLBAMID),
      metrics,
    })
  }
  const chunkSize = 150
  for (let i = 0; i < batch.length; i += chunkSize) {
    const part = batch.slice(i, i + chunkSize)
    const { error } = await supabase.from('stats_batted_ball').upsert(part, {
      onConflict: 'role,split,player_id',
    })
    if (error) console.error('stats_batted_ball', file, error.message)
  }
  console.log(`batted_ball ${role} ${split} ${path.basename(file)}: ${batch.length} rows`)
}

async function importStandard(file, role) {
  const raw = readCsvUtf8(file)
  const rows = parse(raw, csvParseOpts)
  const batch = []
  for (const r of rows) {
    const pid = String(r.PlayerId ?? r.player_id ?? '').trim()
    if (!/^\d+$/.test(pid)) continue
    const teamRaw = String(r.Team ?? '').trim()
    const team = teamRaw && teamRaw !== '- - -' ? teamRaw : null
    await upsertPlayerFromRow(r.Name, pid, team)
    const stats = { ...r }
    delete stats.Name
    delete stats.Team
    delete stats.NameASCII
    delete stats.PlayerId
    delete stats.player_id
    delete stats.MLBAMID
    for (const k of Object.keys(stats)) {
      const v = stats[k]
      if (v != null && v !== '' && typeof v === 'string') {
        const n = num(v)
        if (n !== null) stats[k] = n
      }
    }
    batch.push({
      role,
      player_id: pid,
      player_name: r.Name ?? null,
      team_abbrev: team,
      name_ascii: r.NameASCII ?? null,
      mlbam_id: int(r.MLBAMID),
      g: int(r.G),
      ab: int(r.AB),
      pa: int(r.PA),
      hr: int(r.HR),
      ip: num(r.IP),
      tbf: int(r.TBF),
      stats,
    })
  }
  const chunkSize = 150
  for (let i = 0; i < batch.length; i += chunkSize) {
    const part = batch.slice(i, i + chunkSize)
    const { error } = await supabase.from('stats_standard').upsert(part, {
      onConflict: 'role,player_id',
    })
    if (error) console.error('stats_standard', file, error.message)
  }
  console.log(`standard ${role} ${path.basename(file)}: ${batch.length} rows`)
}

async function main() {
  const dir = path.join(root, 'data')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv'))
  files.sort()
  for (const f of files) {
    const full = path.join(dir, f)

    if (f.toLowerCase().includes('schedule')) {
      await importSchedule(full)
      continue
    }

    const lower = f.toLowerCase()
    if (lower === 'parkfactors2025.csv') {
      await importParkFactors(full, 'overall')
      continue
    }
    if (lower === 'parkfactorsleftyhitters.csv') {
      await importParkFactors(full, 'lefty_hitters')
      continue
    }
    if (lower === 'parkfactorsrightyhitters.csv') {
      await importParkFactors(full, 'righty_hitters')
      continue
    }

    const bb = parseBattedBallFile(path.basename(f, '.csv'))
    if (bb) {
      await importBattedBall(full, bb.role, bb.split)
      continue
    }

    const { role, kind, year } = parseFilename(full)
    if (!role || !kind || (kind !== 'standard' && !year)) {
      console.warn('skip', f)
      continue
    }
    if (kind === 'standard') await importStandard(full, role)
    else if (kind === 'homeruns') await importHomeruns(full, role, year)
    else if (kind === 'exit_velocity') await importExitVelocity(full, role, year)
    else if (kind === 'pitch_arsenal') await importPitchArsenal(full, role, year)
  }
  console.log('Done.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
