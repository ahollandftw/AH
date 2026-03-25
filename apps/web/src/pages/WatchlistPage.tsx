import { useCallback, useEffect, useState } from 'react'
import {
  addToWatchlistByPlayerKey,
  listWatchlistPlayers,
  removeFromWatchlist,
  type WatchlistPlayer,
} from '@kinetic/shared'
import { useWebAuth } from '../auth/WebAuthProvider.tsx'

export default function WatchlistPage() {
  const { supabase, session } = useWebAuth()
  const [loading, setLoading] = useState(true)
  const [players, setPlayers] = useState<WatchlistPlayer[]>([])
  const [newKey, setNewKey] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    if (!supabase || !session) {
      setLoading(false)
      return
    }
    setLoading(true)
    void listWatchlistPlayers(supabase)
      .then(setPlayers)
      .finally(() => setLoading(false))
  }, [supabase, session])

  useEffect(load, [load])

  // TODO: re-enable auth gate when login is ready
  // if (!session) {
  //   return (
  //     <div className="pg">
  //       <h1 className="pg-title">Watchlist</h1>
  //       <p className="pg-empty">Sign in to manage your watchlist.</p>
  //     </div>
  //   )
  // }

  return (
    <div className="pg">
      <h1 className="pg-title">Watchlist</h1>
      <p className="pg-sub">Tracked sluggers ({players.length} total).</p>

      <div className="wl-addRow">
        <input
          className="wl-input"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="Player ID or slug (e.g. 660271)"
        />
        <button
          className="wl-addBtn"
          disabled={newKey.trim().length < 3 || busy || !supabase}
          onClick={() => {
            if (!supabase) return
            setBusy(true)
            void addToWatchlistByPlayerKey(supabase, newKey.trim())
              .then(load)
              .finally(() => {
                setBusy(false)
                setNewKey('')
              })
          }}
        >
          {busy ? '...' : 'Add'}
        </button>
      </div>

      {loading ? (
        <div className="lb-skel">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="lb-skelRow" />
          ))}
        </div>
      ) : players.length === 0 ? (
        <p className="pg-empty">No players yet. Add one above.</p>
      ) : (
        <div className="pg-cards">
          {players.map((p) => (
            <div key={p.playerId} className="pg-card">
              <div className="pg-info">
                <span className="pg-name">{p.name}</span>
                <span className="pg-meta">
                  {(p.team ?? '—').toUpperCase()} &bull; {(p.position ?? '—').toUpperCase()}
                </span>
              </div>
              <button
                className="wl-rmBtn"
                onClick={() => {
                  if (!supabase) return
                  void removeFromWatchlist(supabase, p.playerId).then(load)
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
