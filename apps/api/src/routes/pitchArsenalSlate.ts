/**
 * Slate-wide pitch arsenal vs opposing pitcher (same merge as matchup-card), for Pitches page grid.
 */
import type { Express } from 'express'
import { getServiceClient } from '../supabase.js'
import { listDailyHrProjectionsFromTable, type DailyProjection } from '../hrModelCalc.js'

function canonTeam(team: string): string {
  const t = team.trim().toUpperCase()
  if (t === 'TB' || t === 'TBR') return 'TBR'
  if (t === 'WSH' || t === 'WSN' || t === 'WAS') return 'WSN'
  if (t === 'AZ' || t === 'ARI') return 'ARI'
  if (t === 'KC' || t === 'KCR') return 'KCR'
  if (t === 'SF' || t === 'SFG') return 'SFG'
  if (t === 'SD' || t === 'SDP') return 'SDP'
  if (t === 'OAK' || t === 'ATH') return 'ATH'
  if (t === 'CWS' || t === 'CHW') return 'CHW'
  return t
}

function letterFromGrade(g: number | null): string {
  if (g == null || Number.isNaN(g)) return '—'
  if (g >= 90) return 'A+'
  if (g >= 82) return 'A'
  if (g >= 74) return 'B'
  if (g >= 64) return 'C'
  if (g >= 52) return 'D'
  return 'F'
}

function gradeFromWobaEdge(edge: number | null): number | null {
  if (edge == null || Number.isNaN(edge)) return null
  return Math.round(Math.min(100, Math.max(0, 50 + (edge / 0.04) * 12)))
}

function mergePitchArsenal(pitcherRows: any[], batterRows: any[]): any[] {
  if (!pitcherRows.length || !batterRows.length) return []
  const latestPitcherSeason = Math.max(...pitcherRows.map((r: any) => Number(r.season ?? 0)))
  const latestBatterSeason = Math.max(...batterRows.map((r: any) => Number(r.season ?? 0)))
  const pRows = pitcherRows.filter((r: any) => Number(r.season ?? 0) === latestPitcherSeason)
  const bRows = batterRows.filter((r: any) => Number(r.season ?? 0) === latestBatterSeason)
  const sortedPitcherRows = pRows.slice().sort((a: any, b: any) => Number(b?.pitch_usage ?? 0) - Number(a?.pitch_usage ?? 0))
  const batterByType = new Map<string, any>()
  for (const r of bRows) {
    const key = String(r.pitch_type ?? r.pitch_name ?? '').toUpperCase()
    if (!key) continue
    if (!batterByType.has(key)) batterByType.set(key, r)
  }
  return sortedPitcherRows.map((p: any) => {
    const key = String(p.pitch_type ?? p.pitch_name ?? '').toUpperCase()
    const b = batterByType.get(key) ?? null
    const batterIso = b?.slg != null && b?.ba != null ? Number(b.slg) - Number(b.ba) : null
    const pitcherSlgAllowed = p?.slg != null ? Number(p.slg) : null
    const batterWoba = b?.woba != null ? Number(b.woba) : null
    const pitcherWoba = p?.woba != null ? Number(p.woba) : null
    const edge = batterWoba != null && pitcherWoba != null ? batterWoba - pitcherWoba : null
    return {
      pitch_type: p.pitch_type ?? null,
      pitch_name: p.pitch_name ?? null,
      usage: p.pitch_usage != null ? Number(p.pitch_usage) : null,
      season: p?.season != null ? Number(p.season) : null,
      batter_iso: batterIso,
      batter_slg: b?.slg != null ? Number(b.slg) : null,
      batter_ba: b?.ba != null ? Number(b.ba) : null,
      batter_woba: batterWoba,
      batter_est_woba: b?.est_woba != null ? Number(b.est_woba) : null,
      batter_hard_hit_percent: b?.hard_hit_percent != null ? Number(b.hard_hit_percent) : null,
      pitcher_slg_allowed: pitcherSlgAllowed,
      pitcher_woba_allowed: pitcherWoba,
      pitcher_hard_hit_percent: p?.hard_hit_percent != null ? Number(p.hard_hit_percent) : null,
      woba_edge: edge,
    }
  })
}

function weightedWobaEdge(pitches: any[]): number | null {
  let wSum = 0
  let w = 0
  for (const p of pitches) {
    const usageFrac = (p.usage ?? 0) / 100
    if (p.woba_edge == null || usageFrac <= 0) continue
    wSum += p.woba_edge * usageFrac
    w += usageFrac
  }
  return w > 0 ? wSum / w : null
}

type PitcherPick = { pitcher_bdl_id: number | null; pitcher_name: string | null }

function resolvePitcherFromMatchupRows(
  rows: Array<{ opponent_bdl_player_id?: number | null; at_bats?: number | null }>,
  opponentTeam: string,
  pitcherNameQ: string,
  oppPlayerById: Map<number, { full_name: string | null; team_abbrev: string | null }>,
): PitcherPick | null {
  const oppIds = Array.from(
    new Set(rows.map((r) => Number(r.opponent_bdl_player_id ?? 0)).filter((n) => n > 0)),
  )
  if (!oppIds.length) return null
  const candidates = rows
    .map((r) => {
      const pid = Number(r.opponent_bdl_player_id ?? 0) || null
      const opp = pid ? oppPlayerById.get(pid) : null
      return {
        pitcher_bdl_id: pid,
        pitcher_name: opp?.full_name ?? null,
        pitcher_team: canonTeam(String(opp?.team_abbrev ?? '')),
        at_bats: Number(r.at_bats ?? 0),
      }
    })
    .filter((r) => r.pitcher_team === opponentTeam && r.pitcher_bdl_id)
    .sort((a, b) => b.at_bats - a.at_bats)
  const q = pitcherNameQ.trim().toLowerCase()
  const byName = q
    ? candidates.find((c) => {
        const nm = String(c.pitcher_name ?? '').toLowerCase()
        return nm === q || nm.includes(q) || q.includes(nm)
      }) ?? null
    : null
  const best = byName ?? candidates[0] ?? null
  if (!best?.pitcher_bdl_id) return null
  return { pitcher_bdl_id: best.pitcher_bdl_id, pitcher_name: best.pitcher_name }
}

export function registerPitchArsenalSlateRoute(app: Express) {
  app.get('/bdl/pitch-arsenal/slate', async (req, res) => {
    try {
      const date = String(req.query.date ?? '').trim()
      const season = Number(req.query.season ?? new Date().getFullYear()) || new Date().getFullYear()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ error: 'date=YYYY-MM-DD required' })
        return
      }

      const sb = getServiceClient()
      const projections = await listDailyHrProjectionsFromTable(sb, date, 'default')
      const batters = projections.filter((p) => {
        const pos = String(p.position ?? '').toUpperCase()
        if (pos === 'P' || pos.startsWith('P')) return false
        return true
      })
      if (!batters.length) {
        res.json({ ok: true, date, season, rows: [] })
        return
      }

      const { data: games } = await sb
        .from('bdl_games')
        .select('home_team_abbrev,away_team_abbrev')
        .eq('date', date)
      const oppMap = new Map<string, string>()
      const addPair = (homeRaw: string | null | undefined, awayRaw: string | null | undefined) => {
        const h = canonTeam(String(homeRaw ?? ''))
        const a = canonTeam(String(awayRaw ?? ''))
        if (h && a) {
          oppMap.set(h, a)
          oppMap.set(a, h)
        }
      }
      for (const g of games ?? []) addPair((g as any).home_team_abbrev, (g as any).away_team_abbrev)
      if (!oppMap.size) {
        const { data: sched } = await sb.from('schedule_games').select('home_team,away_team').eq('date', date)
        for (const g of sched ?? []) addPair((g as any).home_team, (g as any).away_team)
      }

      const statIds = [...new Set(batters.map((b) => b.playerId).filter(Boolean))]
      const { data: xrefs } = await sb.from('bdl_players').select('bdl_id,stat_player_id').in('stat_player_id', statIds.slice(0, 500))
      const statToBdl = new Map<string, number>()
      for (const r of xrefs ?? []) {
        const row = r as { stat_player_id?: string | null; bdl_id?: number | null }
        const sid = String(row.stat_player_id ?? '')
        const bid = Number(row.bdl_id ?? 0)
        if (sid && bid > 0) statToBdl.set(sid, bid)
      }

      const rowsByBatterBdl = new Map<number, Array<{ opponent_bdl_player_id?: number | null; at_bats?: number | null }>>()
      const bdlIdsNeedingMatchup = new Set<number>()
      for (const proj of batters) {
        const teamCanon = proj.team ? canonTeam(proj.team) : null
        const opponentTeam = teamCanon ? oppMap.get(teamCanon) ?? null : null
        if (!opponentTeam) continue
        const bdlId = statToBdl.get(proj.playerId)
        if (bdlId) bdlIdsNeedingMatchup.add(bdlId)
      }
      let oppPlayerByIdBatch = new Map<number, { full_name: string | null; team_abbrev: string | null }>()
      if (bdlIdsNeedingMatchup.size) {
        const { data: muRows } = await sb
          .from('bdl_matchups')
          .select('bdl_player_id, opponent_bdl_player_id, at_bats')
          .in('bdl_player_id', [...bdlIdsNeedingMatchup])
        const oppIds = new Set<number>()
        for (const r of muRows ?? []) {
          const o = Number((r as any).opponent_bdl_player_id ?? 0)
          if (o > 0) oppIds.add(o)
        }
        const { data: oppPlayers } = oppIds.size
          ? await sb.from('bdl_players').select('bdl_id,full_name,team_abbrev').in('bdl_id', [...oppIds])
          : { data: [] as any[] }
        oppPlayerByIdBatch = new Map()
        for (const p of oppPlayers ?? []) {
          const row = p as { bdl_id?: number; full_name?: string | null; team_abbrev?: string | null }
          const id = Number(row.bdl_id ?? 0)
          if (id > 0) {
            oppPlayerByIdBatch.set(id, {
              full_name: row.full_name ?? null,
              team_abbrev: row.team_abbrev ?? null,
            })
          }
        }
        for (const r of muRows ?? []) {
          const bid = Number((r as any).bdl_player_id ?? 0)
          if (!bid) continue
          if (!rowsByBatterBdl.has(bid)) rowsByBatterBdl.set(bid, [])
          rowsByBatterBdl.get(bid)!.push({
            opponent_bdl_player_id: (r as any).opponent_bdl_player_id,
            at_bats: (r as any).at_bats,
          })
        }
      }

      const pitcherPicks: Array<{ proj: DailyProjection; pick: PitcherPick | null; opponentTeam: string | null }> = []
      for (const proj of batters) {
        const teamCanon = proj.team ? canonTeam(proj.team) : null
        const opponentTeam = teamCanon ? oppMap.get(teamCanon) ?? null : null
        if (!opponentTeam) {
          pitcherPicks.push({ proj, pick: null, opponentTeam: null })
          continue
        }
        const bdlId = statToBdl.get(proj.playerId)
        if (!bdlId) {
          pitcherPicks.push({ proj, pick: null, opponentTeam })
          continue
        }
        const nameQ = String(proj.opponentPitcher ?? '').trim().toLowerCase()
        const mu = rowsByBatterBdl.get(bdlId) ?? []
        const pick = resolvePitcherFromMatchupRows(mu, opponentTeam, nameQ, oppPlayerByIdBatch)
        pitcherPicks.push({ proj, pick, opponentTeam })
      }

      const pitcherBdlIds = [
        ...new Set(
          pitcherPicks.map((x) => x.pick?.pitcher_bdl_id).filter((id): id is number => id != null && id > 0),
        ),
      ]
      const { data: pitXrefs } = pitcherBdlIds.length
        ? await sb.from('bdl_players').select('bdl_id,stat_player_id').in('bdl_id', pitcherBdlIds)
        : { data: [] as any[] }
      const pitcherBdlToStat = new Map<number, string>()
      for (const r of pitXrefs ?? []) {
        const row = r as { bdl_id?: number | null; stat_player_id?: string | null }
        const bid = Number(row.bdl_id ?? 0)
        const sid = String(row.stat_player_id ?? '').trim()
        if (bid > 0 && sid) pitcherBdlToStat.set(bid, sid)
      }

      const pitcherStatIds = [...new Set([...pitcherBdlToStat.values()].filter(Boolean))]
      const batterStatIds = statIds.slice(0, 500)

      const [pitcherArsRes, batterArsRes] = await Promise.all([
        pitcherStatIds.length
          ? sb
              .from('stats_pitch_arsenal')
              .select(
                'player_id,pitch_type,pitch_name,pitch_usage,slg,ba,woba,est_slg,est_woba,k_percent,whiff_percent,hard_hit_percent,season',
              )
              .eq('role', 'pitching')
              .in('player_id', pitcherStatIds)
              .lte('season', season)
              .order('season', { ascending: false })
              .limit(8000)
          : Promise.resolve({ data: [] as any[] }),
        batterStatIds.length
          ? sb
              .from('stats_pitch_arsenal')
              .select(
                'player_id,pitch_type,pitch_name,pitch_usage,slg,ba,woba,est_slg,est_woba,k_percent,whiff_percent,hard_hit_percent,season',
              )
              .eq('role', 'batting')
              .in('player_id', batterStatIds)
              .lte('season', season)
              .order('season', { ascending: false })
              .limit(20000)
          : Promise.resolve({ data: [] as any[] }),
      ])

      function latestSeasonRows(rows: any[], playerId: string): any[] {
        const mine = (rows ?? []).filter((r: any) => String(r.player_id) === playerId)
        if (!mine.length) return []
        const maxS = Math.max(...mine.map((r: any) => Number(r.season ?? 0)))
        return mine.filter((r: any) => Number(r.season ?? 0) === maxS)
      }

      const pitchRows = pitcherArsRes.data ?? []
      const batRows = batterArsRes.data ?? []

      const out: any[] = []
      for (const { proj, pick, opponentTeam } of pitcherPicks) {
        const pitStat = pick?.pitcher_bdl_id ? pitcherBdlToStat.get(pick.pitcher_bdl_id) : null
        const pRows = pitStat ? latestSeasonRows(pitchRows, pitStat) : []
        const bRows = latestSeasonRows(batRows, proj.playerId)
        const pitches = pRows.length && bRows.length ? mergePitchArsenal(pRows, bRows) : []
        const edge = weightedWobaEdge(pitches)
        const arsenal_grade = gradeFromWobaEdge(edge)
        out.push({
          player_id: proj.playerId,
          batter_name: proj.name,
          team: proj.team,
          opponent_team: opponentTeam,
          pitcher_name: pick?.pitcher_name ?? proj.opponentPitcher ?? null,
          hr_probability: proj.hrProbability,
          tier: proj.tier,
          arsenal_grade,
          grade_letter: letterFromGrade(arsenal_grade),
          pitches,
        })
      }

      res.json({ ok: true, date, season, rows: out })
    } catch (e) {
      console.error('[bdl/pitch-arsenal/slate] failed:', e)
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  })
}
