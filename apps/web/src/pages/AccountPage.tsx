import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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

type ProfileVisibility = 'public' | 'friends' | 'private'
type PlanTier = 'basic' | 'plus'

type DailyPickRow = {
  player_id: string
  hit: boolean | null
  players?: {
    stat_player_id: string
    name: string
    team: string | null
  } | null
}

export default function AccountPage() {
  const navigate = useNavigate()
  const {
    supabase,
    session,
    hasSubscription,
    hasPlus,
    subscriptionReady,
    waiverAccepted,
    signInWithGoogle,
    signInWithOtp,
    signOut,
    acceptLiabilityWaiver,
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
  const [displayName, setDisplayName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [visibility, setVisibility] = useState<ProfileVisibility>('private')
  const [savingProfile, setSavingProfile] = useState(false)
  const [defaultSportsbook, setDefaultSportsbook] = useState('draftkings')
  const [hrNotifications, setHrNotifications] = useState(true)
  const [hrLeagueNotifications, setHrLeagueNotifications] = useState(false)
  const [todayPickDate, setTodayPickDate] = useState(new Date().toISOString().slice(0, 10))
  const [pickQuery, setPickQuery] = useState('')
  const [pickResults, setPickResults] = useState<PlayerOption[]>([])
  const [dailyPicks, setDailyPicks] = useState<DailyPickRow[]>([])
  const [trackingSummary, setTrackingSummary] = useState<{ hits: number; total: number; pct: number } | null>(null)

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
    if (!supabase || !session?.user.id) {
      setDisplayName('')
      setAvatarUrl('')
      setVisibility('private')
      return
    }
    void supabase
      .from('user_settings')
      .select('display_name,avatar_url,profile_visibility,default_sportsbook,hr_notifications,hr_notifications_league')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        setDisplayName(String(data?.display_name ?? ''))
        setAvatarUrl(String(data?.avatar_url ?? ''))
        const raw = String(data?.profile_visibility ?? 'private').toLowerCase()
        setVisibility(raw === 'public' || raw === 'friends' ? raw : 'private')
        setDefaultSportsbook(String(data?.default_sportsbook ?? 'draftkings'))
        setHrNotifications(data?.hr_notifications !== false)
        setHrLeagueNotifications(data?.hr_notifications_league === true)
      })
  }, [session?.user.id, supabase])

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

  const loadDailyPicks = useCallback(() => {
    if (!supabase || !session?.user.id) {
      setDailyPicks([])
      return
    }
    void supabase
      .from('user_daily_picks')
      .select('player_id,hit, players:player_id (stat_player_id,name,team)')
      .eq('user_id', session.user.id)
      .eq('pick_date', todayPickDate)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        const rows = ((data ?? []) as any[]).map((r) => ({
          player_id: String(r.player_id),
          hit: (r.hit as boolean | null | undefined) ?? null,
          players: Array.isArray(r.players) ? (r.players[0] ?? null) : (r.players ?? null),
        })) as DailyPickRow[]
        setDailyPicks(rows)
      })
  }, [session?.user.id, supabase, todayPickDate])

  useEffect(() => {
    loadDailyPicks()
  }, [loadDailyPicks])

  useEffect(() => {
    if (!supabase || !session?.user.id) {
      setTrackingSummary(null)
      return
    }
    void (async () => {
      const { data: picks } = await supabase
        .from('user_daily_picks')
        .select('pick_date,player_id,hit')
        .eq('user_id', session.user.id)
      const pickRows = (picks ?? []) as Array<{ pick_date: string; player_id: string; hit: boolean | null }>
      if (!pickRows.length) {
        setTrackingSummary({ hits: 0, total: 0, pct: 0 })
        return
      }
      const withHit = pickRows.filter((r) => r.hit !== null)
      const hitsFromFlag = withHit.filter((r) => r.hit === true).length
      if (withHit.length === pickRows.length) {
        const total = pickRows.length
        const pct = total ? Number(((hitsFromFlag / total) * 100).toFixed(2)) : 0
        setTrackingSummary({ hits: hitsFromFlag, total, pct })
        return
      }
      const { data: statRows } = await supabase
        .from('player_stats_daily')
        .select('player_id,date,home_runs')
      const hitSet = new Set(
        (statRows ?? [])
          .filter((r: any) => Number(r.home_runs ?? 0) > 0)
          .map((r: any) => `${String(r.player_id)}|${String(r.date)}`),
      )
      let hits = 0
      for (const r of pickRows) {
        if (r.hit === true) hits += 1
        else if (r.hit === false) continue
        else if (hitSet.has(`${r.player_id}|${r.pick_date}`)) hits += 1
      }
      const total = pickRows.length
      const pct = total ? Number(((hits / total) * 100).toFixed(2)) : 0
      setTrackingSummary({ hits, total, pct })
    })()
  }, [session?.user.id, supabase, dailyPicks.length])

  useEffect(() => {
    if (!supabase || !session?.user.id) {
      setPickResults([])
      return
    }
    const q = pickQuery.trim()
    if (q.length < 2) {
      setPickResults([])
      return
    }
    const timer = setTimeout(() => {
      void supabase
        .from('players')
        .select('stat_player_id,name,slug,team,position')
        .or(`name.ilike.%${q}%,slug.ilike.%${q}%`)
        .order('name', { ascending: true })
        .limit(12)
        .then(({ data }) => setPickResults((data ?? []) as PlayerOption[]))
    }, 150)
    return () => clearTimeout(timer)
  }, [pickQuery, session?.user.id, supabase])

  const watchSet = useMemo(() => new Set(players.map((p) => p.playerId)), [players])

  async function addPlayer(playerId: string) {
    if (!supabase) return
    setBusy(true)
    await addToWatchlistByPlayerKey(supabase, playerId)
    await loadWatchlist()
    setBusy(false)
  }

  async function onAvatarFile(file: File | null) {
    if (!file) return
    const reader = new FileReader()
    const out = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsDataURL(file)
    }).catch(() => '')
    if (out) setAvatarUrl(out)
  }

  async function saveProfileSettings() {
    if (!supabase || !session?.user.id) return
    setSavingProfile(true)
    const { error } = await supabase.from('user_settings').upsert(
      {
        user_id: session.user.id,
        display_name: displayName.trim() || null,
        avatar_url: avatarUrl.trim() || null,
        profile_visibility: visibility,
        default_sportsbook: defaultSportsbook,
        hr_notifications: hrNotifications,
        hr_notifications_league: hrLeagueNotifications,
      },
      { onConflict: 'user_id' },
    )
    setSavingProfile(false)
    setMsg(error ? error.message : 'Profile saved.')
  }

  async function addDailyPick(playerId: string) {
    if (!supabase || !session?.user.id) return
    if (dailyPicks.length >= 3) {
      setMsg('Max 3 picks per day.')
      return
    }
    const { error } = await supabase.from('user_daily_picks').insert({
      user_id: session.user.id,
      pick_date: todayPickDate,
      player_id: playerId,
    })
    if (error) {
      setMsg(error.message)
      return
    }
    setPickQuery('')
    setPickResults([])
    loadDailyPicks()
  }

  async function removeDailyPick(playerId: string) {
    if (!supabase || !session?.user.id) return
    await supabase
      .from('user_daily_picks')
      .delete()
      .eq('user_id', session.user.id)
      .eq('pick_date', todayPickDate)
      .eq('player_id', playerId)
    loadDailyPicks()
  }

  async function startCheckout(plan: PlanTier) {
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
          plan,
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

  useEffect(() => {
    if (!supabase || !session?.user.id) return
    void supabase.from('user_stat_snapshots').upsert(
      {
        user_id: session.user.id,
        snapshot_date: new Date().toISOString().slice(0, 10),
        watchlist_count: players.length,
        favorite_team: favoriteTeam,
      },
      { onConflict: 'user_id,snapshot_date' },
    )
  }, [favoriteTeam, players.length, session?.user.id, supabase])

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
      ) : !waiverAccepted ? (
        <div className="acc-card">
          <h2 className="pg-sectionTitle">Liability Waiver Required</h2>
          <p className="pg-sub">
            Accept the waiver to unlock Dugout, Projections, HR Tracking, and the rest of the app.
          </p>
          <div className="pg-focusCard" style={{ marginTop: 8 }}>
            <div className="pg-focusLine"><strong>DISCLAIMER OF LIABILITY</strong></div>
            <div className="pg-focusLine">
              The home run projections and picks provided through this application are intended solely for informational
              and entertainment purposes. All projections are based on statistical models and historical data and do not
              constitute financial, sports betting, or gambling advice.
            </div>
            <div className="pg-focusLine">By using this application, you acknowledge and agree that:</div>
            <div className="pg-focusLine">- No guarantees are made regarding the accuracy or outcome of any projection.</div>
            <div className="pg-focusLine">
              - The developer, owner, and affiliates of this application shall not be held liable for any financial loss,
              damage, or adverse outcome resulting from reliance on the information provided.
            </div>
            <div className="pg-focusLine">
              - Sports betting and gambling may be illegal in your jurisdiction. It is your sole responsibility to ensure
              compliance with all applicable laws.
            </div>
            <div className="pg-focusLine">
              - You assume full responsibility for any decisions made based on the projections displayed in this app.
            </div>
            <div className="pg-focusLine">Use this application at your own risk.</div>
          </div>
          <div className="acc-actions" style={{ marginTop: 10 }}>
            <button type="button" className="wl-addBtn" onClick={() => void acceptLiabilityWaiver()}>
              I accept the waiver
            </button>
            <button
              type="button"
              className="wl-rmBtn"
              onClick={() => {
                setMsg('Waiver not accepted. Access remains limited to Account only.')
                navigate('/account')
              }}
            >
              No
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="acc-card acc-card--hero">
            <p className="pg-sub">Signed in as {session.user.email ?? 'user'}</p>
            <p className="pg-sub">
              Subscription:{' '}
              <strong>
                {subscriptionReady ? (hasPlus ? 'AH+ Active' : hasSubscription ? 'Basic Active' : 'Not active') : 'Loading...'}
              </strong>
            </p>
            <h3 className="pg-sectionTitle">Profile</h3>
            <div className="acc-profileGrid">
              <label className="pg-label" htmlFor="display-name">
                Display name
              </label>
              <input
                id="display-name"
                className="wl-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="How your profile appears"
              />
              <label className="pg-label" htmlFor="avatar-url">
                Avatar URL (or upload file)
              </label>
              <input
                id="avatar-url"
                className="wl-input"
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                placeholder="https://..."
              />
              <input
                className="wl-input"
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  void onAvatarFile(f)
                }}
              />
              <label className="pg-label" htmlFor="profile-visibility">
                Profile visibility
              </label>
              <select
                id="profile-visibility"
                className="acc-select"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as ProfileVisibility)}
              >
                <option value="public">Public (anyone can view)</option>
                <option value="friends">Friends only</option>
                <option value="private">Private</option>
              </select>
              {avatarUrl ? (
                <div className="acc-avatarPreviewWrap">
                  <img src={avatarUrl} alt="Profile preview" className="acc-avatarPreview" />
                </div>
              ) : null}
              <label className="pg-label" htmlFor="default-sportsbook">
                Default sportsbook (for edge calculation)
              </label>
              <select
                id="default-sportsbook"
                className="acc-select"
                value={defaultSportsbook}
                onChange={(e) => setDefaultSportsbook(e.target.value)}
              >
                <option value="draftkings">DraftKings</option>
                <option value="fanduel">FanDuel</option>
                <option value="betmgm">BetMGM</option>
                <option value="fanatics">Fanatics</option>
              </select>
              <label className="pg-label acc-switchRow">
                <span>Pick HR notifications</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={hrNotifications}
                  className={`acc-iosSwitch ${hrNotifications ? 'is-on' : ''}`}
                  onClick={() => setHrNotifications((v) => !v)}
                >
                  <span className="acc-iosKnob" />
                </button>
              </label>
              <label className="pg-label acc-switchRow">
                <span>All-league HR notifications</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={hrLeagueNotifications}
                  className={`acc-iosSwitch ${hrLeagueNotifications ? 'is-on' : ''}`}
                  onClick={() => setHrLeagueNotifications((v) => !v)}
                >
                  <span className="acc-iosKnob" />
                </button>
              </label>
              <button type="button" className="pg-clearBtn" disabled={savingProfile} onClick={saveProfileSettings}>
                {savingProfile ? 'Saving...' : 'Save profile'}
              </button>
              <button type="button" className="wl-rmBtn" onClick={() => void signOut()}>
                Log out
              </button>
            </div>
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
            {!hasSubscription ? (
              <div className="acc-planStack">
                <div className="acc-planCard">
                  <div className="acc-planHead">
                    <h4 className="acc-planTitle">Basic</h4>
                    <span className="acc-planPrice">$5 / month</span>
                  </div>
                  <details className="acc-planDetails">
                    <summary>View features</summary>
                    <ul className="acc-planList">
                      <li>Core app access</li>
                      <li>Daily HR calls (max 3 picks/day)</li>
                      <li>Public leaderboard participation (if profile is public)</li>
                    </ul>
                  </details>
                  <button
                    type="button"
                    className="wl-addBtn acc-planBtn"
                    disabled={loading}
                    onClick={() => void startCheckout('basic')}
                  >
                    {loading ? 'Loading...' : 'Choose Basic'}
                  </button>
                </div>

                <div className="acc-planCard">
                  <div className="acc-planHead">
                    <h4 className="acc-planTitle">AH+</h4>
                    <span className="acc-planPrice">$8 / month</span>
                  </div>
                  <details className="acc-planDetails">
                    <summary>View features</summary>
                    <ul className="acc-planList">
                      <li>Everything in Basic</li>
                      <li>Personal hit-rate tracking and history</li>
                      <li>Advanced account performance insights</li>
                    </ul>
                  </details>
                  <button
                    type="button"
                    className="wl-addBtn acc-planBtn"
                    disabled={loading}
                    onClick={() => void startCheckout('plus')}
                  >
                    {loading ? 'Loading...' : 'Choose AH+'}
                  </button>
                </div>
              </div>
            ) : (
              <p className="pg-sub">Your subscription is active. Plan options are hidden.</p>
            )}
            <div className="acc-actions">
              <button type="button" className="pg-clearBtn" onClick={() => void refreshSubscription()}>
                Refresh status
              </button>
            </div>
            {msg ? <p className="pg-sub">{msg}</p> : null}
          </div>

          <div className="acc-card">
            <h2 className="pg-sectionTitle">Daily HR Calls (max 3)</h2>
            <div className="pg-controls">
              <label className="pg-label" htmlFor="pick-date">
                Pick date
              </label>
              <input
                id="pick-date"
                className="pg-date"
                type="date"
                value={todayPickDate}
                onChange={(e) => setTodayPickDate(e.target.value)}
              />
            </div>
            <div className="acc-searchWrap">
              <input
                className="wl-input acc-searchInput"
                value={pickQuery}
                onChange={(e) => setPickQuery(e.target.value)}
                placeholder="Search player for daily pick..."
              />
            </div>
            {pickResults.length > 0 ? (
              <div className="acc-suggestList">
                {pickResults.map((r) => (
                  <button
                    key={r.stat_player_id}
                    type="button"
                    className="acc-suggestItem"
                    disabled={dailyPicks.some((p) => p.player_id === r.stat_player_id) || dailyPicks.length >= 3}
                    onClick={() => void addDailyPick(r.stat_player_id)}
                  >
                    <span className="acc-suggestMain">{r.name}</span>
                    <span className="acc-suggestMeta">{(r.team ?? '—').toUpperCase()}</span>
                    <span className="acc-suggestAction">Pick</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="pg-cards">
              {dailyPicks.map((p) => (
                <div key={p.player_id} className="pg-card">
                  <div className="pg-info">
                    <span className="pg-name">{p.players?.name ?? p.player_id}</span>
                    <span className="pg-meta">{(p.players?.team ?? '—').toUpperCase()}</span>
                  </div>
                  <span className="pg-prob" style={{ marginRight: 8 }}>
                    {p.hit === true ? 'HR' : p.hit === false ? 'No HR' : 'Pending'}
                  </span>
                  <button type="button" className="wl-rmBtn" onClick={() => void removeDailyPick(p.player_id)}>
                    Remove
                  </button>
                </div>
              ))}
              {dailyPicks.length === 0 ? <p className="pg-empty">No picks yet for this date.</p> : null}
            </div>
            <p className="pg-sub" style={{ marginTop: 10, marginBottom: 0 }}>
              {dailyPicks.length}/3 picks used.
            </p>
          </div>

          <div className="acc-card">
            <h2 className="pg-sectionTitle">My Tracking</h2>
            {trackingSummary ? (
              <p className="pg-sub">
                Lifetime picks: <strong>{trackingSummary.total}</strong> • Hits: <strong>{trackingSummary.hits}</strong> • Hit %:{' '}
                <strong>{trackingSummary.pct.toFixed(2)}%</strong>
                {hasPlus ? null : (
                  <> <span style={{ opacity: 0.85 }}>(AH+ adds deeper performance insights)</span></>
                )}
              </p>
            ) : (
              <p className="pg-sub">Loading your tracking stats...</p>
            )}
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
