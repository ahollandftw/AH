/**
 * Slate-wide pitch arsenal vs opposing pitcher (same merge as matchup-card), for Pitches page grid.
 */
import type { Express } from 'express'
import { getBestLineupsForDate } from '../bdl/lineups.js'
import { getServiceClient } from '../supabase.js'
import { listDailyHrProjectionsFromTable, type DailyProjection } from '../hrModelCalc.js'

/** 5-minute TTL: all data is DB-backed (no BDL calls), so longer cache is safe and faster. */
const slateCache = new Map<string, { at: number; body: unknown }>()
const SLATE_CACHE_MS = 5 * 60 * 1000

async function buildBattersFromLineups(
  sb: ReturnType<typeof getServiceClient>,
  date: string,
  preloadedLineups?: Record<string, any>,
): Promise<DailyProjection[]> {
  const lineupsByGame: Record<string, any> = preloadedLineups ?? await getBestLineupsForDate(sb, date)
  const gameIds = Object.keys(lineupsByGame)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
  if (!gameIds.length) return []

  const { data: gameRows } = await sb
    .from('bdl_games')
    .select('bdl_game_id,home_team_abbrev,away_team_abbrev')
    .in('bdl_game_id', gameIds)
  const gameById = new Map<number, { home: string; away: string }>()
  for (const g of gameRows ?? []) {
    const r = g as { bdl_game_id?: number; home_team_abbrev?: string; away_team_abbrev?: string }
    gameById.set(Number(r.bdl_game_id), {
      home: canonTeam(String(r.home_team_abbrev ?? '')),
      away: canonTeam(String(r.away_team_abbrev ?? '')),
    })
  }

  const seen = new Set<string>()
  const out: DailyProjection[] = []

  for (const [gidStr, lu] of Object.entries(lineupsByGame)) {
    const gid = Number(gidStr)
    const pair = gameById.get(gid)
    if (!pair?.home || !pair?.away) continue
    const { home: homeAbbr, away: awayAbbr } = pair
    const homePitcher = lu.home_pitcher?.full_name ?? null
    const awayPitcher = lu.away_pitcher?.full_name ?? null

    const addSide = (
      side: Array<{
        batting_order?: number | null
        position?: string | null
        stat_player_id?: string | null
        full_name?: string | null
      }>,
      teamAbbr: string,
      opposingPitcher: string | null,
    ) => {
      for (const p of side) {
        if (p.batting_order == null || p.batting_order <= 0) continue
        const pos = String(p.position ?? '').toUpperCase()
        if (pos === 'P' || pos.startsWith('P')) continue
        const sid = String(p.stat_player_id ?? '').trim()
        if (!sid || seen.has(sid)) continue
        seen.add(sid)
        out.push({
          playerId: sid,
          slug: '',
          name: String(p.full_name ?? 'Unknown'),
          team: teamAbbr,
          position: p.position ?? null,
          opponentPitcher: opposingPitcher,
          opponentPitcherHand: null,
          hrProbability: null,
          l7Hrs: null,
          tier: null,
          opponent: null,
          americanOdds: null,
          americanOddsStr: null,
          source: 'daily_table',
        })
      }
    }

    addSide(lu.home, homeAbbr, awayPitcher)
    addSide(lu.away, awayAbbr, homePitcher)
  }

  return out.filter((p) => p.name !== 'Unknown')
}

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

/** BDL team abbrev variants for a canonical code (TB/TBR, etc.). */
function abbrevsForCanonTeam(canon: string): string[] {
  const c = canonTeam(canon)
  const set = new Set<string>([c])
  const map: Record<string, string> = {
    TB: 'TBR',
    TBR: 'TBR',
    WSH: 'WSN',
    WSN: 'WSN',
    WAS: 'WSN',
    AZ: 'ARI',
    ARI: 'ARI',
    KC: 'KCR',
    KCR: 'KCR',
    SF: 'SFG',
    SFG: 'SFG',
    SD: 'SDP',
    SDP: 'SDP',
    OAK: 'ATH',
    ATH: 'ATH',
    CWS: 'CHW',
    CHW: 'CHW',
  }
  for (const [alias, mapped] of Object.entries(map)) {
    if (mapped === c) set.add(alias)
  }
  return [...set]
}

function normalizeNameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** When bdl_matchups is empty or stale, match probable pitcher from lineups / projections to bdl_players. */
async function resolvePitcherPickFromProbableName(
  sb: ReturnType<typeof getServiceClient>,
  opponentTeamCanon: string,
  pitcherNameRaw: string,
): Promise<PitcherPick | null> {
  const q = pitcherNameRaw.trim().toLowerCase()
  if (!q) return null
  const abbrevs = abbrevsForCanonTeam(opponentTeamCanon)
  const { data: rows } = await sb
    .from('bdl_players')
    .select('bdl_id, full_name, team_abbrev')
    .in('team_abbrev', abbrevs)
    .limit(250)
  const candidates = (rows ?? []) as Array<{ bdl_id?: number; full_name?: string | null }>
  const byExact = candidates.find((r) => String(r.full_name ?? '').toLowerCase() === q)
  if (byExact?.bdl_id) {
    return { pitcher_bdl_id: Number(byExact.bdl_id), pitcher_name: byExact.full_name ?? null }
  }
  const byPartial = candidates.find((r) => {
    const nm = String(r.full_name ?? '').toLowerCase()
    return nm.includes(q) || q.includes(nm)
  })
  if (byPartial?.bdl_id) {
    return { pitcher_bdl_id: Number(byPartial.bdl_id), pitcher_name: byPartial.full_name ?? null }
  }
  return null
}

/** Same idea as /bdl/matchup-card: find Statcast player_id when bdl_players.stat_player_id is null. */
async function resolveStatPlayerIdByName(
  sb: ReturnType<typeof getServiceClient>,
  fullName: string | null | undefined,
): Promise<string | null> {
  const raw = String(fullName ?? '').trim()
  if (!raw) return null

  const directLookups = await Promise.all([
    sb.from('players').select('stat_player_id').eq('name', raw).limit(1).maybeSingle(),
    sb.from('stats_standard').select('player_id').eq('player_name', raw).limit(1).maybeSingle(),
  ])
  const directId =
    (directLookups[0].data as { stat_player_id?: string | null } | null)?.stat_player_id ??
    (directLookups[1].data as { player_id?: string | null } | null)?.player_id ??
    null
  if (directId) return String(directId)

  const parts = raw.split(/\s+/).filter(Boolean)
  if (parts.length < 2) return null
  const reversed = `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`
  const { data: arsenalRows } = await sb
    .from('stats_pitch_arsenal')
    .select('player_id,last_name_first_name')
    .ilike('last_name_first_name', `${parts[parts.length - 1]}%`)
    .limit(50)
  const targetNames = new Set([normalizeNameKey(raw), normalizeNameKey(reversed)])
  const match = (arsenalRows ?? []).find((row: { last_name_first_name?: string | null }) =>
    targetNames.has(normalizeNameKey(String(row.last_name_first_name ?? ''))),
  )
  return match?.player_id ? String(match.player_id) : null
}

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

      const cacheKey = `${date}|${season}`
      const cached = slateCache.get(cacheKey)
      if (cached && Date.now() - cached.at < SLATE_CACHE_MS) {
        res.json(cached.body)
        return
      }

      const sb = getServiceClient()

      // Fetch projections (all 3 variants) AND lineups in parallel — zero extra latency
      const [[projDefault, projWeighted, projContact], lineupsByGame] = await Promise.all([
        Promise.all([
          listDailyHrProjectionsFromTable(sb, date, 'default'),
          listDailyHrProjectionsFromTable(sb, date, 'weighted_pitch_arsenal'),
          listDailyHrProjectionsFromTable(sb, date, 'contact_quality'),
        ]),
        getBestLineupsForDate(sb, date).catch(() => ({} as Record<string, any>)),
      ])

      // Build per-player avg HR% across all available model variants
      const hrProbsByPlayer = new Map<string, number[]>()
      for (const list of [projDefault, projWeighted, projContact]) {
        for (const p of list) {
          if (!p.playerId || p.hrProbability == null) continue
          if (!hrProbsByPlayer.has(p.playerId)) hrProbsByPlayer.set(p.playerId, [])
          hrProbsByPlayer.get(p.playerId)!.push(p.hrProbability)
        }
      }
      const hrAvgMap = new Map<string, number>()
      for (const [id, vals] of hrProbsByPlayer) {
        hrAvgMap.set(id, vals.reduce((a, b) => a + b, 0) / vals.length)
      }

      // Build the set of stat_player_ids confirmed in today's starting lineup (batting_order 1–9).
      // This prevents bench players, injured players, or yesterday's lineup remnants from appearing.
      const lineupStarterIds = new Set<string>()
      for (const lu of Object.values(lineupsByGame as Record<string, any>)) {
        for (const side of [lu.home ?? [], lu.away ?? []] as any[][]) {
          for (const p of side) {
            if (p.stat_player_id && p.batting_order != null && p.batting_order >= 1 && p.batting_order <= 9) {
              lineupStarterIds.add(String(p.stat_player_id))
            }
          }
        }
      }

      let batters = projDefault.filter((p) => {
        const pos = String(p.position ?? '').toUpperCase()
        if (pos === 'P' || pos.startsWith('P')) return false
        // Only show players confirmed in today's starting lineup
        if (lineupStarterIds.size > 0 && !lineupStarterIds.has(p.playerId)) return false
        return true
      })
      let batterSource: 'projections' | 'lineups' = 'projections'
      if (!batters.length) {
        try {
          batters = await buildBattersFromLineups(sb, date, lineupsByGame)
          batterSource = 'lineups'
        } catch (e) {
          console.error('[pitch-arsenal/slate] lineup fallback failed:', e)
        }
      }
      if (!batters.length) {
        const body = { ok: true, date, season, rows: [], source: 'empty' as const }
        slateCache.set(cacheKey, { at: Date.now(), body })
        res.json(body)
        return
      }

      const { data: games } = await sb
        .from('bdl_games')
        .select('bdl_game_id,home_team_abbrev,away_team_abbrev')
        .eq('date', date)
      const oppMap = new Map<string, string>()
      // Maps canonical team abbrev → which side of which lineup to look up
      const teamToLineupSide = new Map<string, { gidStr: string; side: 'home' | 'away' }>()
      const addPair = (gid: number | null | undefined, homeRaw: string | null | undefined, awayRaw: string | null | undefined) => {
        const h = canonTeam(String(homeRaw ?? ''))
        const a = canonTeam(String(awayRaw ?? ''))
        if (h && a) {
          oppMap.set(h, a)
          oppMap.set(a, h)
          if (gid) {
            teamToLineupSide.set(h, { gidStr: String(gid), side: 'home' })
            teamToLineupSide.set(a, { gidStr: String(gid), side: 'away' })
          }
        }
      }
      for (const g of games ?? []) addPair((g as any).bdl_game_id, (g as any).home_team_abbrev, (g as any).away_team_abbrev)
      if (!oppMap.size) {
        const { data: sched } = await sb.from('schedule_games').select('home_team,away_team').eq('date', date)
        for (const g of sched ?? []) addPair(null, (g as any).home_team, (g as any).away_team)
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

      for (let i = 0; i < pitcherPicks.length; i++) {
        const row = pitcherPicks[i]
        if (row.pick || !row.opponentTeam) continue

        // Prefer the name from the projection; fall back to lineup cache
        let pitcherNameHint = String(row.proj.opponentPitcher ?? '').trim()
        if (!pitcherNameHint) {
          const batterTeamCanon = row.proj.team ? canonTeam(row.proj.team) : null
          const batterSide = batterTeamCanon ? teamToLineupSide.get(batterTeamCanon) : null
          if (batterSide) {
            const lu = (lineupsByGame as Record<string, any>)[batterSide.gidStr]
            if (lu) {
              // Away batters face the home pitcher; home batters face the away pitcher
              const pitcherInfo = batterSide.side === 'away' ? lu.home_pitcher : lu.away_pitcher
              pitcherNameHint = String((pitcherInfo as any)?.full_name ?? '').trim()
            }
          }
        }

        if (!pitcherNameHint) continue
        const fb = await resolvePitcherPickFromProbableName(sb, row.opponentTeam, pitcherNameHint)
        if (fb) pitcherPicks[i] = { ...row, pick: fb }
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

      const pitcherStatByBdlFallback = new Map<number, string>()
      const resolvedStatIdByPitcherName = new Map<string, string>()
      for (const { pick } of pitcherPicks) {
        if (!pick?.pitcher_bdl_id || !pick.pitcher_name) continue
        if (pitcherBdlToStat.has(pick.pitcher_bdl_id)) continue
        const nk = normalizeNameKey(pick.pitcher_name)
        if (!resolvedStatIdByPitcherName.has(nk)) {
          const sid = await resolveStatPlayerIdByName(sb, pick.pitcher_name)
          resolvedStatIdByPitcherName.set(nk, sid ?? '')
        }
        const sid = resolvedStatIdByPitcherName.get(nk)
        if (sid) pitcherStatByBdlFallback.set(pick.pitcher_bdl_id, sid)
      }

      const pitcherStatIds = [
        ...new Set([...pitcherBdlToStat.values(), ...pitcherStatByBdlFallback.values()].filter(Boolean)),
      ]
      const batterStatIds = statIds.slice(0, 500)

      const arsenalSelect =
        'player_id,pitch_type,pitch_name,pitch_usage,slg,ba,woba,est_slg,est_woba,k_percent,whiff_percent,hard_hit_percent,season'

      async function loadPitchingArsenal(): Promise<any[]> {
        if (!pitcherStatIds.length) return []
        const q1 = await sb
          .from('stats_pitch_arsenal')
          .select(arsenalSelect)
          .eq('role', 'pitching')
          .in('player_id', pitcherStatIds)
          .eq('season', season)
          .limit(6000)
        if ((q1.data?.length ?? 0) > 0) return q1.data ?? []
        const q2 = await sb
          .from('stats_pitch_arsenal')
          .select(arsenalSelect)
          .eq('role', 'pitching')
          .in('player_id', pitcherStatIds)
          .lte('season', season)
          .order('season', { ascending: false })
          .limit(8000)
        return q2.data ?? []
      }

      async function loadBattingArsenal(): Promise<any[]> {
        if (!batterStatIds.length) return []
        const q1 = await sb
          .from('stats_pitch_arsenal')
          .select(arsenalSelect)
          .eq('role', 'batting')
          .in('player_id', batterStatIds)
          .eq('season', season)
          .limit(15000)
        if ((q1.data?.length ?? 0) > 0) return q1.data ?? []
        const q2 = await sb
          .from('stats_pitch_arsenal')
          .select(arsenalSelect)
          .eq('role', 'batting')
          .in('player_id', batterStatIds)
          .lte('season', season)
          .order('season', { ascending: false })
          .limit(20000)
        return q2.data ?? []
      }

      const [pitchRowsRaw, batRowsRaw] = await Promise.all([loadPitchingArsenal(), loadBattingArsenal()])

      function latestSeasonRows(rows: any[], playerId: string): any[] {
        const mine = (rows ?? []).filter((r: any) => String(r.player_id) === playerId)
        if (!mine.length) return []
        const maxS = Math.max(...mine.map((r: any) => Number(r.season ?? 0)))
        return mine.filter((r: any) => Number(r.season ?? 0) === maxS)
      }

      const pitchRows = pitchRowsRaw
      const batRows = batRowsRaw

      const out: any[] = []
      for (const { proj, pick, opponentTeam } of pitcherPicks) {
        let pitStat = pick?.pitcher_bdl_id ? pitcherBdlToStat.get(pick.pitcher_bdl_id) : null
        if (!pitStat && pick?.pitcher_bdl_id) {
          pitStat = pitcherStatByBdlFallback.get(pick.pitcher_bdl_id) ?? null
        }
        const pRows = pitStat ? latestSeasonRows(pitchRows, pitStat) : []
        const bRows = latestSeasonRows(batRows, proj.playerId)
        const pitches = pRows.length && bRows.length ? mergePitchArsenal(pRows, bRows) : []
        const edge = weightedWobaEdge(pitches)
        const arsenal_grade = gradeFromWobaEdge(edge)
        // hr_probability = avg of all 3 models (falls back to default-only if others missing)
        const hr_probability = hrAvgMap.get(proj.playerId) ?? proj.hrProbability
        out.push({
          player_id: proj.playerId,
          batter_name: proj.name,
          team: proj.team,
          opponent_team: opponentTeam,
          pitcher_name: pick?.pitcher_name ?? proj.opponentPitcher ?? null,
          hr_probability,
          tier: proj.tier,
          arsenal_grade,
          grade_letter: letterFromGrade(arsenal_grade),
          pitches,
          pitcher_stat_id: pitStat ?? null,
        })
      }

      // ── Pitcher aggregation (pure JS, no extra DB calls) ──────────────
      type PitcherGroup = {
        pitcher_name: string
        pitcher_team: string
        batter_team: string
        pitcher_stat_id: string | null
        batters: typeof out
      }
      const pitcherGroupMap = new Map<string, PitcherGroup>()
      for (const row of out) {
        if (!row.pitcher_name || !row.opponent_team) continue
        const key = `${row.pitcher_name}|${row.opponent_team}`
        if (!pitcherGroupMap.has(key)) {
          pitcherGroupMap.set(key, {
            pitcher_name: row.pitcher_name,
            pitcher_team: row.opponent_team,
            batter_team: row.team ?? '',
            pitcher_stat_id: row.pitcher_stat_id,
            batters: [],
          })
        }
        pitcherGroupMap.get(key)!.batters.push(row)
      }

      const pitchers = [...pitcherGroupMap.values()].map((group) => {
        const validGrades = group.batters
          .map((b: any) => b.arsenal_grade)
          .filter((g: any): g is number => typeof g === 'number' && !Number.isNaN(g))
        const validHrProbs = group.batters
          .map((b: any) => b.hr_probability)
          .filter((p: any): p is number => typeof p === 'number' && !Number.isNaN(p))

        const avgArsenalGrade =
          validGrades.length ? validGrades.reduce((a: number, b: number) => a + b, 0) / validGrades.length : null
        const avgBatterHrProb =
          validHrProbs.length ? validHrProbs.reduce((a: number, b: number) => a + b, 0) / validHrProbs.length : null

        // Pitcher grade: primary signal is the inversion of the avg batter-edge grade.
        // Lower avg batter grade = pitcher has more edge = higher pitcher grade.
        const arsenal_pitcher_grade = avgArsenalGrade != null ? 100 - avgArsenalGrade : null

        // Secondary adjustment (±10 pts max) from K% and hard-hit% allowed.
        // Using these instead of raw wOBA avoids pitch-type baseline variance issues.
        let statsAdj = 0
        if (group.pitcher_stat_id) {
          const pRows = latestSeasonRows(pitchRows, group.pitcher_stat_id)
          if (pRows.length) {
            let kNumer = 0, kW = 0, hhNumer = 0, hhW = 0
            for (const p of pRows) {
              const u = Number(p.pitch_usage ?? 0) / 100
              if (u <= 0) continue
              const k = Number(p.k_percent ?? 0)
              if (k > 0) { kNumer += k * u; kW += u }
              const hh = Number(p.hard_hit_percent ?? 0)
              if (hh > 0) { hhNumer += hh * u; hhW += u }
            }
            const avgK = kW > 0 ? kNumer / kW : null
            const avgHardHit = hhW > 0 ? hhNumer / hhW : null
            // League avg: K% ~22%, hard hit% ~38%
            const kAdj = avgK != null ? ((avgK - 22) / 4) * 4 : 0
            const hhAdj = avgHardHit != null ? ((38 - avgHardHit) / 4) * 4 : 0
            statsAdj = Math.min(10, Math.max(-10, kAdj + hhAdj))
          }
        }

        const pitcher_grade =
          arsenal_pitcher_grade != null
            ? Math.min(95, Math.max(5, Math.round(arsenal_pitcher_grade + statsAdj)))
            : null

        return {
          pitcher_name: group.pitcher_name,
          pitcher_team: group.pitcher_team,
          batter_team: group.batter_team,
          avg_batter_hr_prob: avgBatterHrProb,
          avg_arsenal_grade: avgArsenalGrade != null ? Math.round(avgArsenalGrade) : null,
          pitcher_grade,
          pitcher_grade_letter: letterFromGrade(pitcher_grade),
          batters: group.batters
            .slice()
            .sort((a: any, b: any) => ((b.hr_probability ?? -1) - (a.hr_probability ?? -1)))
            .map((b: any) => ({
              player_id: b.player_id,
              batter_name: b.batter_name,
              team: b.team,
              hr_probability: b.hr_probability,
              arsenal_grade: b.arsenal_grade,
              grade_letter: b.grade_letter,
              pitches: b.pitches,
            })),
        }
      })
      // Slate-relative grade: 100 = best pitcher on slate, 0 = worst (normalized across all starters)
      {
        const slateGradeValues = pitchers.map((p) => p.pitcher_grade).filter((g): g is number => g != null)
        const slateMin = slateGradeValues.length ? Math.min(...slateGradeValues) : 0
        const slateMax = slateGradeValues.length ? Math.max(...slateGradeValues) : 100
        const slateRange = slateMax - slateMin
        for (const p of pitchers) {
          const sg =
            p.pitcher_grade == null
              ? null
              : slateRange === 0
                ? 50
                : Math.round(((p.pitcher_grade - slateMin) / slateRange) * 100)
          ;(p as any).slate_grade = sg
          ;(p as any).slate_grade_letter = sg != null ? letterFromGrade(sg) : '—'
        }
      }

      // Supplement each pitcher's batter list with any lineup players who didn't have
      // Statcast arsenal data (so the Pitchers tab always shows all 9 opposing batters)
      for (const pitcher of pitchers) {
        const batterTeamCanon = pitcher.batter_team ? canonTeam(pitcher.batter_team) : null
        if (!batterTeamCanon) continue
        const gameSide = teamToLineupSide.get(batterTeamCanon)
        if (!gameSide) continue
        const lu = (lineupsByGame as Record<string, any>)[gameSide.gidStr]
        if (!lu) continue
        const sideArr: any[] = gameSide.side === 'home' ? (lu.home ?? []) : (lu.away ?? [])
        const existingIds = new Set(pitcher.batters.map((b: any) => b.player_id))
        for (const p of sideArr) {
          if (!p.batting_order || p.batting_order <= 0) continue
          const pos = String(p.position ?? '').toUpperCase()
          if (pos === 'P' || pos.startsWith('P')) continue
          const sid = String(p.stat_player_id ?? '').trim()
          if (!sid || existingIds.has(sid)) continue
          pitcher.batters.push({
            player_id: sid,
            batter_name: p.full_name ?? 'Unknown',
            team: batterTeamCanon,
            hr_probability: hrAvgMap.get(sid) ?? null,
            arsenal_grade: null,
            grade_letter: '—',
            pitches: [],
          })
          existingIds.add(sid)
        }
        // Re-sort: batters with HR data first, then alphabetical for unknowns; cap at 9 (one full batting order)
        pitcher.batters.sort((a: any, b: any) => ((b.hr_probability ?? -1) - (a.hr_probability ?? -1)))
        pitcher.batters = pitcher.batters.slice(0, 9)
      }

      // Sort pitchers: lowest grade first (worst matchup for pitcher = most interesting)
      pitchers.sort((a, b) => (a.pitcher_grade ?? 50) - (b.pitcher_grade ?? 50))

      // Strip pitcher_stat_id from public response (internal field)
      const rows = out.map(({ pitcher_stat_id: _s, ...r }: any) => r)

      const body = { ok: true, date, season, rows, pitchers, source: batterSource }
      slateCache.set(cacheKey, { at: Date.now(), body })
      res.json(body)
    } catch (e) {
      console.error('[bdl/pitch-arsenal/slate] failed:', e)
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  })
}
