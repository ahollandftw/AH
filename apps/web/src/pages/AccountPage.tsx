import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  addToWatchlistByPlayerKey,
  fetchBattingAdjXhrLeaderboard,
  fetchMaxBattingHomerunYear,
  listWatchlistPlayers,
  removeFromWatchlist,
  type WatchlistPlayer,
} from '@kinetic/shared'
import { useWebAuth } from '../auth/WebAuthProvider.tsx'
import { FAVORITE_TEAM_OPTIONS } from '../theme/teamPalette'

type PlayerOption = {
  stat_player_id: string
  name: string
  slug: string
  team: string | null
  position: string | null
}

export default function AccountPage() {
  const {
    supabase,
    session,
    hasSubscription,
    subscriptionReady,
    signInWithGoogle,
    signInWithOtp,
    signOut,
    refreshSubscription,
    favoriteTeam,
    setFavoriteTeam,
  } = useWebAuth()
  const [email, setEmail] = useState('')
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(false)
  const [players, setPlayers] = useState<WatchlistPlayer[]>([])
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<PlayerOption[]>([])
  const [recommended, setRecommended] = useState<PlayerOption[]>([])
  const [busy, setBusy] = useState(false)

  const loadWatchlist = useCallback(() => {
    if (!supabase || !session) {
      setPlayers([])
      return
    }
    void listWatchlistPlayers(supabase).then(setPlayers)
  }, [session, supabase])

  useEffect(() => {
    loadWatchlist()
  }, [loadWatchlist])

  useEffect(() => {
    if (!supabase || !session) {
      setSearchResults([])
      return
    }
    const q = query.trim()
    if (q.length < 2) {
      setSearchResults([])
      return
    }
    const timer = setTimeout(() => {
      void supabase
        .from('players')
        .select('stat_player_id,name,slug,team,position')
        .or(`name.ilike.%${q}%,slug.ilike.%${q}%`)
        .order('name', { ascending: true })
        .limit(12)
        .then(({ data }) => {
          setSearchResults((data ?? []) as PlayerOption[])
        })
    }, 150)
    return () => clearTimeout(timer)
  }, [query, session, supabase])

  useEffect(() => {
    if (!supabase || !session) {
      setRecommended([])
      return
    }
    void (async () => {
      const year = await fetchMaxBattingHomerunYear(supabase)
      if (!year) {
        setRecommended([])
        return
      }
      const rows = await fetchBattingAdjXhrLeaderboard(supabase, year)
      if (!rows.length) {
        setRecommended([])
        return
      }
      const topIds = rows.slice(0, 24).map((r) => r.player_id)
      const { data } = await supabase
        .from('players')
        .select('stat_player_id,name,slug,team,position')
        .in('stat_player_id', topIds)
      const map = new Map((data ?? []).map((p: any) => [p.stat_player_id, p as PlayerOption]))
      const ordered: PlayerOption[] = []
      for (const id of topIds) {
        const p = map.get(id)
        if (p) ordered.push(p)
        if (ordered.length >= 12) break
      }
      setRecommended(ordered)
    })()
  }, [session, supabase])

  const watchSet = useMemo(() => new Set(players.map((p) => p.playerId)), [players])

  async function addPlayer(playerId: string) {
    if (!supabase) return
    setBusy(true)
    await addToWatchlistByPlayerKey(supabase, playerId)
    await loadWatchlist()
    setBusy(false)
  }

  async function startCheckout() {
    if (!session) return
    setLoading(true)
    setMsg('')
    try {
      const base = import.meta.env.VITE_API_BASE_URL ?? ''
      const res = await fetch(`${base}/billing/create-checkout-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: session.user.id,
          email: session.user.email,
        }),
      })
      if (!res.ok) {
        throw new Error(await res.text())
      }
      const data = (await res.json()) as { url?: string }
      if (!data.url) {
        throw new Error('Stripe session URL missing')
      }
      window.location.assign(data.url)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed to start checkout')
      setLoading(false)
    }
  }

  return (
    <div className="pg">
      <h1 className="pg-title">Account</h1>
      {!session ? (
        <div className="acc-card">
          <p className="pg-sub">Sign in with Google or email link.</p>
          <div className="acc-actions">
            <button
              type="button"
              className="wl-addBtn"
              onClick={async () => {
                setLoading(true)
                const r = await signInWithGoogle()
                setLoading(false)
                if (!r.ok) setMsg(r.message)
              }}
              disabled={loading}
            >
              {loading ? '...' : 'Continue with Google'}
            </button>
          </div>
          <div className="wl-addRow">
            <input
              className="wl-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email for magic link"
            />
            <button
              className="wl-addBtn"
              disabled={email.trim().length < 5 || loading}
              onClick={async () => {
                setLoading(true)
                const r = await signInWithOtp(email.trim())
                setLoading(false)
                setMsg(r.ok ? 'Check your email for sign-in link.' : r.message)
              }}
            >
              Email sign in
            </button>
          </div>
          {msg ? <p className="pg-sub">{msg}</p> : null}
        </div>
      ) : (
        <>
          <div className="acc-card acc-card--hero">
            <p className="pg-sub">Signed in as {session.user.email ?? 'user'}</p>
            <p className="pg-sub">
              Subscription:{' '}
              <strong>{subscriptionReady ? (hasSubscription ? 'Active' : 'Not active') : 'Loading...'}</strong>
            </p>
            <div className="acc-teamRow">
              <label className="pg-label" htmlFor="favorite-team">
                Favorite team theme
              </label>
              <select
                id="favorite-team"
                className="acc-select"
                value={favoriteTeam ?? ''}
                onChange={(e) => {
                  const v = e.target.value || null
                  void setFavoriteTeam(v)
                }}
              >
                <option value="">Default (Red / White / Blue)</option>
                {FAVORITE_TEAM_OPTIONS.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
            <div className="acc-actions">
              <button
                type="button"
                className="pg-clearBtn"
                onClick={startCheckout}
              >
                {hasSubscription ? 'Manage / renew subscription' : 'Start subscription'}
              </button>
              <button type="button" className="pg-clearBtn" onClick={() => void refreshSubscription()}>
                Refresh status
              </button>
              <button type="button" className="pg-clearBtn" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
            {msg ? <p className="pg-sub">{msg}</p> : null}
          </div>

          <div className="acc-card">
            <h2 className="pg-sectionTitle">Watchlist</h2>
            <p className="pg-sub">Search by name (e.g. Aaron, Altuve, Ramirez).</p>
            <div className="acc-searchWrap">
              <input
                className="wl-input acc-searchInput"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Type player name..."
              />
            </div>
            {searchResults.length > 0 ? (
              <div className="acc-suggestList">
                {searchResults.map((r) => (
                  <button
                    key={r.stat_player_id}
                    type="button"
                    className="acc-suggestItem"
                    disabled={busy || watchSet.has(r.stat_player_id)}
                    onClick={() => {
                      void addPlayer(r.stat_player_id)
                      setQuery('')
                      setSearchResults([])
                    }}
                  >
                    <span className="acc-suggestMain">{r.name}</span>
                    <span className="acc-suggestMeta">
                      {(r.team ?? '—').toUpperCase()} • {(r.position ?? '—').toUpperCase()}
                    </span>
                    <span className="acc-suggestAction">
                      {watchSet.has(r.stat_player_id) ? 'Added' : 'Add'}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            <h3 className="pg-sectionTitle" style={{ marginTop: 14 }}>Recommended players</h3>
            <div className="acc-chipGrid">
              {recommended.map((r) => (
                <button
                  key={r.stat_player_id}
                  type="button"
                  className="acc-chip"
                  disabled={busy || watchSet.has(r.stat_player_id)}
                  onClick={() => void addPlayer(r.stat_player_id)}
                >
                  <span>{r.name}</span>
                  <small>{(r.team ?? '—').toUpperCase()}</small>
                  <strong>{watchSet.has(r.stat_player_id) ? 'Added' : 'Add'}</strong>
                </button>
              ))}
            </div>

            {players.length === 0 ? (
              <p className="pg-empty">No watchlist players yet.</p>
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
                        void removeFromWatchlist(supabase, p.playerId).then(loadWatchlist)
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
