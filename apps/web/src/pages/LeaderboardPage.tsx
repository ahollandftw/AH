import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWebAuth } from '../auth/WebAuthProvider.tsx'

type SortKey = 'date' | 'stadium' | 'team' | 'pitcher' | 'batter'

type HrEventRow = {
  id: number
  game_date: string | null
  stadium: string | null
  home_team: string | null
  away_team: string | null
  batter_team: string | null
  batter_name: string | null
  pitcher_name: string | null
  batter_home_away: string | null
  pitcher_home_away: string | null
  pitch_type: string | null
  distance: number | null
  today_probability: number | null
  stat_player_id: string | null
}

type HomersResponse = {
  last_updated: string
  season: number
  count: number
  events: HrEventRow[]
}

const apiBase = () => import.meta.env.VITE_API_BASE_URL ?? ''

function fmtPct(x: number | null | undefined): string {
  if (x == null || Number.isNaN(x)) return '—'
  return `${(x * 100).toFixed(1)}%`
}

export default function LeaderboardPage() {
  const { hasSubscription } = useWebAuth()
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<HomersResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [season, setSeason] = useState(() => new Date().getFullYear())
  const [sort, setSort] = useState<SortKey>('date')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [stadium, setStadium] = useState('')
  const [team, setTeam] = useState('')
  const [pitcher, setPitcher] = useState('')
  const [batter, setBatter] = useState('')

  const qs = useMemo(() => {
    const p = new URLSearchParams()
    p.set('season', String(season))
    p.set('sort', sort)
    p.set('dir', dir)
    if (stadium.trim()) p.set('stadium', stadium.trim())
    if (team.trim()) p.set('team', team.trim())
    if (pitcher.trim()) p.set('pitcher', pitcher.trim())
    if (batter.trim()) p.set('batter', batter.trim())
    return p.toString()
  }, [season, sort, dir, stadium, team, pitcher, batter])

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch(`${apiBase()}/leaderboard/homers?${qs}`)
      if (!res.ok) throw new Error(await res.text())
      setData((await res.json()) as HomersResponse)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [qs])

  useEffect(() => {
    void load()
  }, [load])

  if (!hasSubscription) {
    return (
      <div className="lb-wrap">
        <h1 className="lb-title">Homer Tracking</h1>
        <p className="lb-meta">Subscription required.</p>
        <p className="lb-err">
          Homer Tracking is locked on free accounts. Visit Account to manage your subscription.
        </p>
      </div>
    )
  }

  return (
    <div className="lb-wrap">
      <h1 className="lb-title">Homer Tracking</h1>
      <p className="lb-meta">
        Last updated:{' '}
        {data?.last_updated ? new Date(data.last_updated).toLocaleString() : '—'}
      </p>

      <div className="lb-toolbar lb-toolbar--sort">
        <label className="lb-field">
          <span className="lb-fieldLabel">Season</span>
          <input
            className="lb-input"
            type="number"
            value={season}
            min={2020}
            max={2035}
            onChange={(e) => setSeason(Number(e.target.value) || season)}
          />
        </label>
        <label className="lb-field">
          <span className="lb-fieldLabel">Sort</span>
          <select className="lb-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="date">Date</option>
            <option value="stadium">Stadium</option>
            <option value="team">Team</option>
            <option value="pitcher">Pitcher</option>
            <option value="batter">Batter</option>
          </select>
        </label>
        <label className="lb-field">
          <span className="lb-fieldLabel">Direction</span>
          <select className="lb-select" value={dir} onChange={(e) => setDir(e.target.value as 'asc' | 'desc')}>
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </label>
      </div>

      <div className="lb-filtersCard">
        <div className="lb-filtersTitle">Filter results</div>
        <div className="lb-toolbar lb-toolbar--filters">
          <label className="lb-field lb-field--grow">
            <span className="lb-fieldLabel">Stadium</span>
            <input
              className="lb-input"
              placeholder="Contains…"
              value={stadium}
              onChange={(e) => setStadium(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="lb-field lb-field--grow">
            <span className="lb-fieldLabel">Team</span>
            <input
              className="lb-input"
              placeholder="e.g. NYY, SF"
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="lb-field lb-field--grow">
            <span className="lb-fieldLabel">Pitcher</span>
            <input
              className="lb-input"
              placeholder="Last name…"
              value={pitcher}
              onChange={(e) => setPitcher(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="lb-field lb-field--grow">
            <span className="lb-fieldLabel">Batter</span>
            <input
              className="lb-input"
              placeholder="Last name…"
              value={batter}
              onChange={(e) => setBatter(e.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="lb-field lb-field--btn">
            <span className="lb-fieldLabel lb-fieldLabel--ghost">Apply</span>
            <button type="button" className="lb-btnApply" onClick={() => void load()}>
              Apply filters
            </button>
          </div>
        </div>
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
            <colgroup>
              <col className="lb-col-date" />
              <col className="lb-col-stadium" />
              <col className="lb-col-abbr" />
              <col className="lb-col-abbr" />
              <col className="lb-col-team" />
              <col className="lb-col-name" />
              <col className="lb-col-name" />
              <col className="lb-col-ha" />
              <col className="lb-col-ha" />
              <col className="lb-col-pitch" />
              <col className="lb-col-dist" />
              <col className="lb-col-pct" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Stadium</th>
                <th scope="col">Home</th>
                <th scope="col">Away</th>
                <th scope="col">Batter team</th>
                <th scope="col">Batter</th>
                <th scope="col">Pitcher</th>
                <th scope="col">Bat H/A</th>
                <th scope="col">Pit H/A</th>
                <th scope="col">Pitch</th>
                <th scope="col">Dist.</th>
                <th scope="col">Today %</th>
              </tr>
            </thead>
            <tbody>
              {(data?.events ?? []).map((p) => (
                <tr key={p.id}>
                  <td className="lb-cell-mono">{p.game_date ?? '—'}</td>
                  <td className="lb-cell-stadium" title={p.stadium ?? undefined}>
                    {p.stadium ?? '—'}
                  </td>
                  <td className="lb-cell-abbr">{p.home_team ?? '—'}</td>
                  <td className="lb-cell-abbr">{p.away_team ?? '—'}</td>
                  <td className="lb-cell-abbr">{p.batter_team ?? '—'}</td>
                  <td title={p.batter_name ?? undefined}>{p.batter_name ?? '—'}</td>
                  <td title={p.pitcher_name ?? undefined}>{p.pitcher_name ?? '—'}</td>
                  <td className="lb-cell-center">{p.batter_home_away ?? '—'}</td>
                  <td className="lb-cell-center">{p.pitcher_home_away ?? '—'}</td>
                  <td className="lb-cell-pitch" title={p.pitch_type ?? undefined}>
                    {p.pitch_type ?? '—'}
                  </td>
                  <td className="lb-cell-mono lb-cell-center">
                    {p.distance != null ? `${p.distance}′` : '—'}
                  </td>
                  <td className="lb-cell-mono lb-cell-pct">
                    {p.today_probability != null ? fmtPct(p.today_probability) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
