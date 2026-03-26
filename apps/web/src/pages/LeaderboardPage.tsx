import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAppDisplayDateIso } from '@kinetic/shared'
import { useWebAuth } from '../auth/WebAuthProvider.tsx'

type RangeDays = 1 | 7 | 14 | 30

type HomerRow = {
  stat_player_id: string
  player_name: string | null
  team: string | null
  opponent_pitcher: string | null
  pitch_type: string | null
  distance: number | null
  hr_total_year: number
  hr_rate: number | null // HR / AB (AB ~= attempts)
  today_probability: number | null
}

type HomerResponse = {
  last_updated: string
  date: string
  season: number
  count: number
  players: HomerRow[]
}

const apiBase = () => import.meta.env.VITE_API_BASE_URL ?? ''

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
  const [rangeDays, setRangeDays] = useState<RangeDays>(1)
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<HomerResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const dateIso = useMemo(() => getAppDisplayDateIso(), [])

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch(
        `${apiBase()}/leaderboard/homers?date=${encodeURIComponent(dateIso)}&days=${rangeDays}`,
      )
      if (!res.ok) throw new Error(await res.text())
      setData((await res.json()) as HomerResponse)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [dateIso, rangeDays])

  useEffect(() => {
    void load()
  }, [load])

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

  return (
    <div className="lb-wrap">
      <h1 className="lb-title">Stats</h1>
      <p className="lb-meta">
        Last updated:{' '}
        {data?.last_updated ? new Date(data.last_updated).toLocaleString() : '—'}
      </p>

      <div className="lb-tabs" style={{ marginBottom: 14 }}>
        {(
          [
            [1, 'Today'],
            [7, 'Last 7'],
            [14, 'Last 14'],
            [30, 'Last month'],
          ] as const
        ).map(([d, label]) => (
          <button
            key={d}
            type="button"
            className={rangeDays === d ? 'lb-tab lb-tabOn' : 'lb-tab'}
            onClick={() => setRangeDays(d)}
          >
            {label}
          </button>
        ))}
      </div>

      {err ? <p className="lb-err">{err}</p> : null}

      {loading ? (
        <div className="lb-skel">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="lb-skelRow" />
          ))}
        </div>
      ) : (
        <div className="lb-tableWrap">
          <table className="lb-table">
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col">Team</th>
                <th scope="col">Opp. Pitcher</th>
                <th scope="col">Pitch type</th>
                <th scope="col">Distance</th>
                <th scope="col">HR total (year)</th>
                <th scope="col">today%</th>
                <th scope="col">HR/AB</th>
              </tr>
            </thead>
            <tbody>
              {(data?.players ?? []).map((p) => (
                <tr key={p.stat_player_id}>
                  <td>{p.player_name ?? '—'}</td>
                  <td>{p.team ?? '—'}</td>
                  <td>{p.opponent_pitcher ?? '—'}</td>
                  <td>{p.pitch_type ?? '—'}</td>
                  <td>{p.distance != null ? `${p.distance} ft` : '—'}</td>
                  <td>{p.hr_total_year}</td>
                  <td>{p.today_probability != null ? fmtPct(p.today_probability) : '—'}</td>
                  <td>{p.hr_rate != null ? fmtNum(p.hr_rate, 4) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
