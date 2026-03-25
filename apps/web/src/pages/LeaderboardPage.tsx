import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWebAuth } from '../auth/WebAuthProvider.tsx'

type Tab = 'hot' | 'cold' | 'buy-low' | 'sell-high'

type PlayerAgg = {
  player_id: number
  player_name: string | null
  team: string | null
  position: string | null
  sample_size_pa: number
  last7_barrel_rate: number | null
  last7_hard_hit_rate: number | null
  hr_score: number | null
  expected_hr: number | null
  actual_hr: number
  hr_diff: number | null
  low_sample: boolean
}

type ApiResponse = {
  last_updated: string
  count: number
  players: PlayerAgg[]
}

type SortKey =
  | 'player_name'
  | 'team'
  | 'hr_score'
  | 'last7_barrel_rate'
  | 'last7_hard_hit_rate'
  | 'expected_hr'
  | 'actual_hr'
  | 'hr_diff'
  | 'sample_size_pa'

const apiBase = () => import.meta.env.VITE_API_BASE_URL ?? ''

function endpoint(tab: Tab): string {
  const p =
    tab === 'hot'
      ? '/leaderboard/hot'
      : tab === 'cold'
        ? '/leaderboard/cold'
        : tab === 'buy-low'
          ? '/leaderboard/buy-low'
          : '/leaderboard/sell-high'
  return `${apiBase()}${p}`
}

function fmtPct(x: number | null | undefined): string {
  if (x == null || Number.isNaN(x)) return '—'
  return `${(x * 100).toFixed(1)}%`
}

function fmtNum(x: number | null | undefined, d = 2): string {
  if (x == null || Number.isNaN(x)) return '—'
  return x.toFixed(d)
}

export default function LeaderboardPage() {
  const { hasSubscription } = useWebAuth()
  const [tab, setTab] = useState<Tab>('hot')
  const [includeLow, setIncludeLow] = useState(false)
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<ApiResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('hr_score')
  const [sortAsc, setSortAsc] = useState(false)

  if (!hasSubscription) {
    return (
      <div className="lb-wrap">
        <h1 className="lb-title">Stats</h1>
        <p className="lb-meta">Subscription required.</p>
        <p className="lb-err">
          Stats are locked on free accounts. Visit Account to manage your subscription.
        </p>
      </div>
    )
  }

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const q = includeLow ? '?include_low_sample=true' : ''
      const res = await fetch(`${endpoint(tab)}${q}`)
      if (!res.ok) throw new Error(await res.text())
      const json = (await res.json()) as ApiResponse
      setData(json)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [tab, includeLow])

  useEffect(() => {
    void load()
  }, [load])

  const sorted = useMemo(() => {
    const rows = data?.players ?? []
    const mult = sortAsc ? 1 : -1
    const v = (k: SortKey, p: PlayerAgg): string | number => {
      switch (k) {
        case 'player_name':
          return (p.player_name ?? '').toLowerCase()
        case 'team':
          return (p.team ?? '').toLowerCase()
        case 'hr_score':
          return p.hr_score ?? -1e9
        case 'last7_barrel_rate':
          return p.last7_barrel_rate ?? -1e9
        case 'last7_hard_hit_rate':
          return p.last7_hard_hit_rate ?? -1e9
        case 'expected_hr':
          return p.expected_hr ?? -1e9
        case 'actual_hr':
          return p.actual_hr
        case 'hr_diff':
          return p.hr_diff ?? -1e9
        case 'sample_size_pa':
          return p.sample_size_pa
        default:
          return 0
      }
    }
    const out = [...rows]
    out.sort((a, b) => {
      const A = v(sortKey, a)
      const B = v(sortKey, b)
      if (typeof A === 'string' && typeof B === 'string') {
        return mult * A.localeCompare(B)
      }
      return mult * (Number(A) - Number(B))
    })
    return out
  }, [data, sortKey, sortAsc])

  function header(k: SortKey, label: string) {
    return (
      <th
        scope="col"
        className="lb-sort"
        onClick={() => {
          if (sortKey === k) setSortAsc(!sortAsc)
          else {
            setSortKey(k)
            setSortAsc(false)
          }
        }}
      >
        {label}
        {sortKey === k ? (sortAsc ? ' ▲' : ' ▼') : ''}
      </th>
    )
  }

  return (
    <div className="lb-wrap">
      <h1 className="lb-title">Stats</h1>
      <p className="lb-meta">
        Last updated:{' '}
        {data?.last_updated ? new Date(data.last_updated).toLocaleString() : '—'}
      </p>

      <div className="lb-tabs">
        {(
          [
            ['hot', 'Hot'],
            ['cold', 'Cold'],
            ['buy-low', 'Buy low'],
            ['sell-high', 'Sell high'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? 'lb-tab lb-tabOn' : 'lb-tab'}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="lb-check">
        <input
          type="checkbox"
          checked={includeLow}
          onChange={(e) => setIncludeLow(e.target.checked)}
        />
        Include low sample (last 7 &lt; 10 PA)
      </label>

      {err ? <p className="lb-err">{err}</p> : null}

      {loading ? (
        <div className="lb-skel">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="lb-skelRow" />
          ))}
        </div>
      ) : (
        <div className="lb-tableWrap">
          <table className="lb-table">
            <thead>
              <tr>
                {header('player_name', 'Player')}
                {header('team', 'Team')}
                {header('hr_score', 'HR score')}
                {header('last7_barrel_rate', 'Barrel rate (L7)')}
                {header('last7_hard_hit_rate', 'Hard-hit (L7)')}
                {header('expected_hr', 'Expected HR')}
                {header('actual_hr', 'Actual HR')}
                {header('hr_diff', 'HR diff')}
                {header('sample_size_pa', 'Sample (L7 PA)')}
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => {
                const edge = p.hr_diff ?? 0
                const rowCls =
                  edge > 0 ? 'lb-rowPos' : edge < 0 ? 'lb-rowNeg' : ''
                return (
                  <tr key={p.player_id} className={rowCls}>
                    <td>{p.player_name ?? '—'}</td>
                    <td>{p.team ?? '—'}</td>
                    <td>{fmtNum(p.hr_score, 3)}</td>
                    <td>{fmtPct(p.last7_barrel_rate)}</td>
                    <td>{fmtPct(p.last7_hard_hit_rate)}</td>
                    <td>{fmtNum(p.expected_hr, 2)}</td>
                    <td>{p.actual_hr}</td>
                    <td>{fmtNum(p.hr_diff, 2)}</td>
                    <td>
                      {p.sample_size_pa}
                      {p.low_sample ? (
                        <span title="Small sample size" className="lb-warn">
                          {' '}
                          ⚠️
                        </span>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
