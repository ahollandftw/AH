import { useEffect, useMemo, useState } from 'react'
import { useWebAuth } from '../auth/WebAuthProvider.tsx'

type LeaderboardRow = {
  user_id: string
  display_name: string | null
  avatar_url: string | null
  hits: number
  total_picks: number
  hit_pct: number
}

type UserPickRow = {
  player_id: string
  player_name: string | null
  team: string | null
  was_hit: boolean
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export default function CommunityLeaderboardPage() {
  const { supabase } = useWebAuth()
  const [rows, setRows] = useState<LeaderboardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState(todayIso())
  const [selectedPicks, setSelectedPicks] = useState<UserPickRow[]>([])

  useEffect(() => {
    if (!supabase) return
    void (async () => {
      setLoading(true)
      setErr(null)
      const { data, error } = await supabase.rpc('user_pick_leaderboard', { limit_rows: 200 })
      if (error) {
        setErr(error.message)
        setRows([])
      } else {
        setRows((data ?? []) as LeaderboardRow[])
      }
      setLoading(false)
    })()
  }, [supabase])

  useEffect(() => {
    if (!supabase || !selectedUserId) {
      setSelectedPicks([])
      return
    }
    void supabase
      .rpc('user_profile_picks_for_date', { target_user_id: selectedUserId, target_date: selectedDate })
      .then(({ data }) => setSelectedPicks((data ?? []) as UserPickRow[]))
  }, [selectedDate, selectedUserId, supabase])

  const selectedUser = useMemo(
    () => rows.find((r) => r.user_id === selectedUserId) ?? null,
    [rows, selectedUserId],
  )

  return (
    <div className="pg">
      <h1 className="pg-title">Leaderboard</h1>
      <p className="pg-sub">
        All users ranked by hit percentage (including zero picks). Click a user to review their picks by date when their profile allows it.
      </p>
      {err ? <p className="pg-err">{err}</p> : null}
      {loading ? (
        <div className="lb-skel">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="lb-skelRow" />
          ))}
        </div>
      ) : (
        <div className="pg-cards">
          {rows.map((r, idx) => (
            <button
              key={r.user_id}
              type="button"
              className="pg-card pg-cardBtn"
              onClick={() => setSelectedUserId(r.user_id)}
            >
              <div className="pg-rank">#{idx + 1}</div>
              <div className="pg-info">
                <span className="pg-name">{r.display_name ?? 'User'}</span>
                <span className="pg-meta">
                  Hit %: {Number(r.hit_pct ?? 0).toFixed(2)}% • Hits: {r.hits} • Picks: {r.total_picks}
                </span>
              </div>
              <span className="pg-prob">{Number(r.hit_pct ?? 0).toFixed(2)}%</span>
            </button>
          ))}
        </div>
      )}

      {selectedUser ? (
        <section className="pg-section">
          <h2 className="pg-sectionTitle">{selectedUser.display_name ?? 'User'} picks</h2>
          <div className="pg-controls">
            <label className="pg-label" htmlFor="leaderboard-date">
              Date
            </label>
            <input
              id="leaderboard-date"
              className="pg-date"
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            />
          </div>
          {selectedPicks.length === 0 ? (
            <p className="pg-empty">No picks for this day, or profile visibility does not allow viewing.</p>
          ) : (
            <div className="pg-cards">
              {selectedPicks.map((p) => (
                <div key={p.player_id} className="pg-card">
                  <div className="pg-info">
                    <span className="pg-name">{p.player_name ?? p.player_id}</span>
                    <span className="pg-meta">{(p.team ?? '—').toUpperCase()}</span>
                  </div>
                  <span className="pg-prob">{p.was_hit ? 'HR HIT' : 'No HR'}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  )
}
