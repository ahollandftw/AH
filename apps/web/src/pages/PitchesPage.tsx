import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getAppDisplayDateIso } from '@kinetic/shared'
import { resolveApiBaseUrl } from '../utils/apiBase'

type PitchDetail = {
  pitch_type: string | null
  pitch_name: string | null
  usage: number | null
  batter_woba: number | null
  pitcher_woba_allowed: number | null
  woba_edge: number | null
  batter_iso: number | null
  pitcher_slg_allowed: number | null
  batter_hard_hit_percent: number | null
  pitcher_hard_hit_percent: number | null
}

type SlateBatter = {
  player_id: string
  batter_name: string
  team: string | null
  opponent_team: string | null
  pitcher_name: string | null
  hr_probability: number | null
  tier: string | null
  arsenal_grade: number | null
  grade_letter: string
  pitches: PitchDetail[]
}

type PitcherBatter = {
  player_id: string
  batter_name: string
  team: string | null
  hr_probability: number | null
  arsenal_grade: number | null
  grade_letter: string
  pitches: PitchDetail[]
}

type SlatePitcher = {
  pitcher_name: string
  pitcher_team: string
  batter_team: string
  avg_batter_hr_prob: number | null
  avg_arsenal_grade: number | null
  pitcher_grade: number | null
  pitcher_grade_letter: string
  batters: PitcherBatter[]
}

type BatterSortKey =
  | 'batter_name'
  | 'team'
  | 'opponent_team'
  | 'pitcher_name'
  | 'hr_probability'
  | 'tier'
  | 'arsenal_grade'
  | 'grade_letter'

type PitcherSortKey = 'pitcher_name' | 'pitcher_team' | 'batter_team' | 'avg_batter_hr_prob' | 'pitcher_grade' | 'pitcher_grade_letter'

function fmtPct(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return '—'
  return `${(p * 100).toFixed(1)}%`
}

function fmtNum(n: number | null | undefined, d = 3): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toFixed(d)
}

function gradeClass(letter: string): string {
  if (letter === '—') return 'pitch-grade--na'
  if (letter.startsWith('A')) return 'pitch-grade--A'
  return `pitch-grade--${letter.charAt(0)}`
}

export default function PitchesPage() {
  const [displayDate, setDisplayDate] = useState(getAppDisplayDateIso())
  const season = useMemo(() => {
    const y = Number(displayDate.slice(0, 4))
    return y >= 2020 && y <= 2100 ? y : new Date().getFullYear()
  }, [displayDate])

  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<SlateBatter[]>([])
  const [pitchers, setPitchers] = useState<SlatePitcher[]>([])

  const [activeTab, setActiveTab] = useState<'batters' | 'pitchers'>('batters')

  // Batter sort
  const [batterSort, setBatterSort] = useState<BatterSortKey>('arsenal_grade')
  const [batterDir, setBatterDir] = useState<'asc' | 'desc'>('desc')
  const [expandedBatter, setExpandedBatter] = useState<string | null>(null)

  // Pitcher sort
  const [pitcherSort, setPitcherSort] = useState<PitcherSortKey>('pitcher_grade')
  const [pitcherDir, setPitcherDir] = useState<'asc' | 'desc'>('asc')
  const [expandedPitcher, setExpandedPitcher] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const base = resolveApiBaseUrl()
    const q = new URLSearchParams({ date: displayDate, season: String(season) })
    try {
      const res = await fetch(`${base}/bdl/pitch-arsenal/slate?${q.toString()}`)
      const json = (await res.json()) as {
        ok?: boolean
        rows?: SlateBatter[]
        pitchers?: SlatePitcher[]
        error?: string
      }
      if (!res.ok) {
        setErr(json?.error ?? 'Failed to load pitch arsenal slate')
        setRows([])
        setPitchers([])
        return
      }
      setRows(json.rows ?? [])
      setPitchers(json.pitchers ?? [])
    } catch (e) {
      setErr(String(e))
      setRows([])
      setPitchers([])
    } finally {
      setLoading(false)
    }
  }, [displayDate, season])

  useEffect(() => {
    void load()
  }, [load])

  // ── Batter sort ────────────────────────────────────────────
  const sortedBatters = useMemo(() => {
    const copy = [...rows]
    const mul = batterDir === 'asc' ? 1 : -1
    copy.sort((a, b) => {
      const av = a[batterSort]
      const bv = b[batterSort]
      if (
        batterSort === 'batter_name' ||
        batterSort === 'team' ||
        batterSort === 'opponent_team' ||
        batterSort === 'pitcher_name' ||
        batterSort === 'tier' ||
        batterSort === 'grade_letter'
      ) {
        return String(av ?? '').localeCompare(String(bv ?? '')) * mul
      }
      const an = typeof av === 'number' && !Number.isNaN(av) ? av : -1e9
      const bn = typeof bv === 'number' && !Number.isNaN(bv) ? bv : -1e9
      return (an - bn) * mul
    })
    return copy
  }, [rows, batterSort, batterDir])

  // ── Pitcher sort ────────────────────────────────────────────
  const sortedPitchers = useMemo(() => {
    const copy = [...pitchers]
    const mul = pitcherDir === 'asc' ? 1 : -1
    copy.sort((a, b) => {
      const av = a[pitcherSort]
      const bv = b[pitcherSort]
      if (pitcherSort === 'pitcher_name' || pitcherSort === 'pitcher_team' || pitcherSort === 'batter_team' || pitcherSort === 'pitcher_grade_letter') {
        return String(av ?? '').localeCompare(String(bv ?? '')) * mul
      }
      const an = typeof av === 'number' && !Number.isNaN(av) ? av : -1e9
      const bn = typeof bv === 'number' && !Number.isNaN(bv) ? bv : -1e9
      return (an - bn) * mul
    })
    return copy
  }, [pitchers, pitcherSort, pitcherDir])

  function toggleBatterSort(k: BatterSortKey) {
    if (batterSort === k) setBatterDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setBatterSort(k)
      setBatterDir(k === 'batter_name' || k === 'team' ? 'asc' : 'desc')
    }
  }

  function togglePitcherSort(k: PitcherSortKey) {
    if (pitcherSort === k) setPitcherDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setPitcherSort(k)
      setPitcherDir(k === 'pitcher_name' || k === 'pitcher_team' || k === 'batter_team' ? 'asc' : 'asc')
    }
  }

  const sortArrow = (active: boolean, dir: 'asc' | 'desc') => (active ? (dir === 'asc' ? ' ↑' : ' ↓') : '')

  return (
    <div className="lb-wrap">
      <h1 className="lb-title">Pitches</h1>
      <p className="lb-meta">
        Pitch-type arsenal matchups (Statcast). HR% is averaged across all three projection models.
      </p>

      <div className="lb-toolbar" style={{ marginBottom: 16 }}>
        <label className="lb-field">
          <span className="lb-fieldLabel">Slate date</span>
          <input
            className="lb-input"
            type="date"
            value={displayDate}
            onChange={(e) => setDisplayDate(e.target.value)}
          />
        </label>
        <button type="button" className="lb-btnApply" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {/* Tab selector */}
      <div className="pitch-tabs">
        <button
          type="button"
          className={`pitch-tab ${activeTab === 'batters' ? 'pitch-tab--active' : ''}`}
          onClick={() => setActiveTab('batters')}
        >
          Batters
          {rows.length > 0 && <span className="pitch-tab-count">{rows.length}</span>}
        </button>
        <button
          type="button"
          className={`pitch-tab ${activeTab === 'pitchers' ? 'pitch-tab--active' : ''}`}
          onClick={() => setActiveTab('pitchers')}
        >
          Pitchers
          {pitchers.length > 0 && <span className="pitch-tab-count">{pitchers.length}</span>}
        </button>
      </div>

      {err ? <p className="lb-err">{err}</p> : null}

      {loading ? (
        <div className="lb-skel">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="lb-skelRow" />
          ))}
        </div>
      ) : activeTab === 'batters' ? (
        sortedBatters.length === 0 ? (
          <p className="lb-meta">
            No batters for {displayDate}. Ensure games exist and projections have been run for this date.
          </p>
        ) : (
          <div className="lb-tableWrap">
            <table className="lb-table pitch-slate-table">
              <thead>
                <tr>
                  <th scope="col">
                    <button type="button" className="pitch-sort" onClick={() => toggleBatterSort('batter_name')}>
                      Batter{sortArrow(batterSort === 'batter_name', batterDir)}
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" className="pitch-sort" onClick={() => toggleBatterSort('team')}>
                      Team{sortArrow(batterSort === 'team', batterDir)}
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" className="pitch-sort" onClick={() => toggleBatterSort('opponent_team')}>
                      Opp{sortArrow(batterSort === 'opponent_team', batterDir)}
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" className="pitch-sort" onClick={() => toggleBatterSort('pitcher_name')}>
                      Pitcher{sortArrow(batterSort === 'pitcher_name', batterDir)}
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" className="pitch-sort" onClick={() => toggleBatterSort('hr_probability')}>
                      HR%{sortArrow(batterSort === 'hr_probability', batterDir)}
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" className="pitch-sort" onClick={() => toggleBatterSort('tier')}>
                      Tier{sortArrow(batterSort === 'tier', batterDir)}
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" className="pitch-sort" onClick={() => toggleBatterSort('grade_letter')}>
                      Grd{sortArrow(batterSort === 'grade_letter', batterDir)}
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" className="pitch-sort" onClick={() => toggleBatterSort('arsenal_grade')}>
                      Score{sortArrow(batterSort === 'arsenal_grade', batterDir)}
                    </button>
                  </th>
                  <th scope="col"> </th>
                </tr>
              </thead>
              <tbody>
                {sortedBatters.map((r) => (
                  <Fragment key={r.player_id}>
                    <tr
                      className="lb-rowInteractive"
                      onClick={() => setExpandedBatter((e) => (e === r.player_id ? null : r.player_id))}
                    >
                      <td>{r.batter_name}</td>
                      <td className="lb-cell-abbr">{r.team ?? '—'}</td>
                      <td className="lb-cell-abbr">{r.opponent_team ?? '—'}</td>
                      <td>{r.pitcher_name ?? '—'}</td>
                      <td>{fmtPct(r.hr_probability)}</td>
                      <td>{r.tier ?? '—'}</td>
                      <td>
                        <span className={`pitch-grade pitch-grade--${gradeClass(r.grade_letter).replace('pitch-grade--', '')}`}>
                          {r.grade_letter}
                        </span>
                      </td>
                      <td>{r.arsenal_grade != null ? r.arsenal_grade : '—'}</td>
                      <td>
                        <Link
                          to={`/projections?date=${encodeURIComponent(displayDate)}&player=${encodeURIComponent(r.player_id)}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          Card
                        </Link>
                      </td>
                    </tr>
                    {expandedBatter === r.player_id && r.pitches?.length ? (
                      <tr key={`${r.player_id}-detail`} className="pitch-detail-row">
                        <td colSpan={9}>
                          <div className="pitch-detail-wrap">
                            <table className="lb-table pitch-nested">
                              <thead>
                                <tr>
                                  <th>Pitch</th>
                                  <th>Usage</th>
                                  <th>B wOBA</th>
                                  <th>P wOBA</th>
                                  <th>Edge</th>
                                  <th>B ISO</th>
                                  <th>P SLG</th>
                                  <th>B HH%</th>
                                  <th>P HH%</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.pitches.map((p, i) => (
                                  <tr key={`${r.player_id}-p-${i}`}>
                                    <td>{p.pitch_name ?? p.pitch_type ?? '—'}</td>
                                    <td>{p.usage != null ? `${p.usage.toFixed(1)}%` : '—'}</td>
                                    <td>{fmtNum(p.batter_woba)}</td>
                                    <td>{fmtNum(p.pitcher_woba_allowed)}</td>
                                    <td className={p.woba_edge != null && p.woba_edge > 0 ? 'pitch-edge-pos' : 'pitch-edge-neg'}>
                                      {fmtNum(p.woba_edge)}
                                    </td>
                                    <td>{fmtNum(p.batter_iso)}</td>
                                    <td>{fmtNum(p.pitcher_slg_allowed)}</td>
                                    <td>{fmtNum(p.batter_hard_hit_percent, 1)}</td>
                                    <td>{fmtNum(p.pitcher_hard_hit_percent, 1)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : /* pitchers tab */ sortedPitchers.length === 0 ? (
        <p className="lb-meta">
          No pitcher data for {displayDate}. Ensure projections have been run for this date.
        </p>
      ) : (
        <div className="lb-tableWrap">
          <table className="lb-table pitch-slate-table">
            <thead>
              <tr>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => togglePitcherSort('pitcher_name')}>
                    Pitcher{sortArrow(pitcherSort === 'pitcher_name', pitcherDir)}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => togglePitcherSort('pitcher_team')}>
                    Team{sortArrow(pitcherSort === 'pitcher_team', pitcherDir)}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => togglePitcherSort('batter_team')}>
                    vs{sortArrow(pitcherSort === 'batter_team', pitcherDir)}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => togglePitcherSort('pitcher_grade_letter')}>
                    Grd{sortArrow(pitcherSort === 'pitcher_grade_letter', pitcherDir)}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => togglePitcherSort('pitcher_grade')}>
                    Score{sortArrow(pitcherSort === 'pitcher_grade', pitcherDir)}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => togglePitcherSort('avg_batter_hr_prob')}>
                    Opp HR%{sortArrow(pitcherSort === 'avg_batter_hr_prob', pitcherDir)}
                  </button>
                </th>
                <th scope="col">Batters</th>
              </tr>
            </thead>
            <tbody>
              {sortedPitchers.map((p) => {
                const key = `${p.pitcher_name}|${p.pitcher_team}`
                const isExpanded = expandedPitcher === key
                return (
                  <Fragment key={key}>
                    <tr
                      className="lb-rowInteractive"
                      onClick={() => setExpandedPitcher((e) => (e === key ? null : key))}
                    >
                      <td>{p.pitcher_name}</td>
                      <td className="lb-cell-abbr">{p.pitcher_team || '—'}</td>
                      <td className="lb-cell-abbr">{p.batter_team || '—'}</td>
                      <td>
                        <span className={`pitch-grade pitch-grade--${gradeClass(p.pitcher_grade_letter).replace('pitch-grade--', '')}`}>
                          {p.pitcher_grade_letter}
                        </span>
                      </td>
                      <td>{p.pitcher_grade ?? '—'}</td>
                      <td>{fmtPct(p.avg_batter_hr_prob)}</td>
                      <td className="pitch-batter-count">{p.batters.length}</td>
                    </tr>
                    {isExpanded ? (
                      <tr key={`${key}-detail`} className="pitch-detail-row">
                        <td colSpan={7}>
                          <div className="pitch-detail-wrap">
                            <table className="lb-table pitch-nested pitch-nested--batters">
                              <thead>
                                <tr>
                                  <th>Batter</th>
                                  <th>HR%</th>
                                  <th>Grd</th>
                                  <th>Score</th>
                                  <th>Top Pitch</th>
                                  <th>Edge</th>
                                </tr>
                              </thead>
                              <tbody>
                                {p.batters.map((b) => {
                                  const topPitch = b.pitches?.length
                                    ? b.pitches.slice().sort((x, y) => (y.woba_edge ?? -99) - (x.woba_edge ?? -99))[0]
                                    : null
                                  return (
                                    <tr key={b.player_id}>
                                      <td>
                                        <Link
                                          to={`/projections?date=${encodeURIComponent(displayDate)}&player=${encodeURIComponent(b.player_id)}`}
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          {b.batter_name}
                                        </Link>
                                      </td>
                                      <td>{fmtPct(b.hr_probability)}</td>
                                      <td>
                                        <span className={`pitch-grade pitch-grade--${gradeClass(b.grade_letter).replace('pitch-grade--', '')}`}>
                                          {b.grade_letter}
                                        </span>
                                      </td>
                                      <td>{b.arsenal_grade ?? '—'}</td>
                                      <td>{topPitch ? (topPitch.pitch_name ?? topPitch.pitch_type ?? '—') : '—'}</td>
                                      <td className={topPitch?.woba_edge != null && topPitch.woba_edge > 0 ? 'pitch-edge-pos' : 'pitch-edge-neg'}>
                                        {fmtNum(topPitch?.woba_edge)}
                                      </td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
