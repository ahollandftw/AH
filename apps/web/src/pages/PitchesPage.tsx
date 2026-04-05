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

type SortKey =
  | 'batter_name'
  | 'team'
  | 'opponent_team'
  | 'pitcher_name'
  | 'hr_probability'
  | 'tier'
  | 'arsenal_grade'
  | 'grade_letter'

function fmtPct(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return '—'
  return `${(p * 100).toFixed(1)}%`
}

function fmtNum(n: number | null | undefined, d = 3): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toFixed(d)
}

export default function PitchesPage() {
  const [displayDate, setDisplayDate] = useState(getAppDisplayDateIso())
  const [season] = useState(() => new Date().getFullYear())
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<SlateBatter[]>([])
  const [sortKey, setSortKey] = useState<SortKey>('arsenal_grade')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const base = resolveApiBaseUrl()
    const q = new URLSearchParams({ date: displayDate, season: String(season) })
    try {
      const res = await fetch(`${base}/bdl/pitch-arsenal/slate?${q.toString()}`)
      const json = (await res.json()) as { ok?: boolean; rows?: SlateBatter[]; error?: string }
      if (!res.ok) {
        setErr(json?.error ?? 'Failed to load pitch arsenal slate')
        setRows([])
        return
      }
      setRows(json.rows ?? [])
    } catch (e) {
      setErr(String(e))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [displayDate, season])

  useEffect(() => {
    void load()
  }, [load])

  const sorted = useMemo(() => {
    const copy = [...rows]
    const mul = sortDir === 'asc' ? 1 : -1
    copy.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (sortKey === 'batter_name' || sortKey === 'team' || sortKey === 'opponent_team' || sortKey === 'pitcher_name' || sortKey === 'tier' || sortKey === 'grade_letter') {
        const as = String(av ?? '')
        const bs = String(bv ?? '')
        return as.localeCompare(bs) * mul
      }
      const an = av != null && typeof av === 'number' && !Number.isNaN(av) ? av : -1e9
      const bn = bv != null && typeof bv === 'number' && !Number.isNaN(bv) ? bv : -1e9
      return (an - bn) * mul
    })
    return copy
  }, [rows, sortKey, sortDir])

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(k)
      setSortDir(k === 'batter_name' || k === 'team' ? 'asc' : 'desc')
    }
  }

  return (
    <div className="lb-wrap">
      <h1 className="lb-title">Pitches</h1>
      <p className="lb-meta">
        Pitch-type arsenal vs today&apos;s opposing pitcher (Statcast), matched the same way as matchup cards. Sort by grade,
        wOBA edge, or HR model tier.
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

      {err ? <p className="lb-err">{err}</p> : null}

      {loading ? (
        <div className="lb-skel">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="lb-skelRow" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <p className="lb-meta">No slate batters or projections for {displayDate}. Run daily sync or pick a day with games.</p>
      ) : (
        <div className="lb-tableWrap">
          <table className="lb-table pitch-slate-table">
            <thead>
              <tr>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => toggleSort('batter_name')}>
                    Batter {sortKey === 'batter_name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => toggleSort('team')}>
                    Team {sortKey === 'team' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => toggleSort('opponent_team')}>
                    Opp {sortKey === 'opponent_team' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => toggleSort('pitcher_name')}>
                    Pitcher {sortKey === 'pitcher_name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => toggleSort('hr_probability')}>
                    HR% {sortKey === 'hr_probability' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => toggleSort('tier')}>
                    Tier {sortKey === 'tier' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => toggleSort('grade_letter')}>
                    Grd {sortKey === 'grade_letter' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className="pitch-sort" onClick={() => toggleSort('arsenal_grade')}>
                    Score {sortKey === 'arsenal_grade' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th scope="col"> </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <Fragment key={r.player_id}>
                  <tr
                    className="lb-rowInteractive"
                    onClick={() => setExpanded((e) => (e === r.player_id ? null : r.player_id))}
                  >
                    <td>{r.batter_name}</td>
                    <td className="lb-cell-abbr">{r.team ?? '—'}</td>
                    <td className="lb-cell-abbr">{r.opponent_team ?? '—'}</td>
                    <td>{r.pitcher_name ?? '—'}</td>
                    <td>{fmtPct(r.hr_probability)}</td>
                    <td>{r.tier ?? '—'}</td>
                    <td>
                      <span
                        className={`pitch-grade pitch-grade--${
                          r.grade_letter === '—' ? 'na' : (r.grade_letter.startsWith('A') ? 'A' : r.grade_letter.charAt(0))
                        }`}
                      >
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
                  {expanded === r.player_id && r.pitches?.length ? (
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
      )}
    </div>
  )
}
