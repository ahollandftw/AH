import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseClient } from '@kinetic/shared'
import { paletteForTeam, type TeamPalette } from '../theme/teamPalette'

type AuthCtx = {
  supabase: SupabaseClient | null
  session: Session | null
  ready: boolean
  hasSubscription: boolean
  hasPlus: boolean
  subscriptionReady: boolean
  favoriteTeam: string | null
  palette: TeamPalette
  signInWithOtp: (email: string) => Promise<{ ok: true } | { ok: false; message: string }>
  verifyOtp: (email: string, token: string) => Promise<{ ok: true } | { ok: false; message: string }>
  signInWithGoogle: () => Promise<{ ok: true } | { ok: false; message: string }>
  setFavoriteTeam: (team: string | null) => Promise<void>
  refreshSubscription: () => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

function randomDisplayName(): string {
  const a = ['Clutch', 'Moonshot', 'Heat', 'Prime', 'Fastball', 'Launch', 'Barrel', 'Rally']
  const b = ['Slugger', 'Hitter', 'Hustler', 'Captain', 'Scout', 'Hammer', 'Ace', 'MVP']
  const left = a[Math.floor(Math.random() * a.length)]
  const right = b[Math.floor(Math.random() * b.length)]
  const n = Math.floor(100 + Math.random() * 900)
  return `${left}${right}${n}`
}

function makeSingleton() {
  if (!url || !key) return null
  return createSupabaseClient(url, key)
}

export function WebAuthProvider({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(makeSingleton, [])
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [hasSubscription, setHasSubscription] = useState(false)
  const [hasPlus, setHasPlus] = useState(false)
  const [subscriptionReady, setSubscriptionReady] = useState(false)
  const [favoriteTeam, setFavoriteTeamState] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) {
      setReady(true)
      return
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
      setReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_ev, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [supabase])

  const refreshSubscription = useCallback(async () => {
    if (!supabase || !session?.user.id) {
      setHasSubscription(false)
      setHasPlus(false)
      setSubscriptionReady(true)
      return
    }
    setSubscriptionReady(false)
    const userId = session.user.id
    const { data, error } = await supabase
      .from('user_subscriptions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) {
      setHasSubscription(false)
      setHasPlus(false)
      setSubscriptionReady(true)
      return
    }
    if (!data) {
      await supabase
        .from('user_subscriptions')
        .upsert({ user_id: userId, has_subscription: false, has_plus: false, plan_tier: 'free' })
      setHasSubscription(false)
      setHasPlus(false)
      setSubscriptionReady(true)
      return
    }
    setHasSubscription(Boolean((data as any).has_subscription))
    setHasPlus(Boolean((data as any).has_plus))
    setSubscriptionReady(true)
  }, [session?.user.id, supabase])

  useEffect(() => {
    void refreshSubscription()
  }, [refreshSubscription])

  const setFavoriteTeam = useCallback(
    async (team: string | null) => {
      setFavoriteTeamState(team)
      if (!supabase || !session?.user.id) {
        if (team) localStorage.setItem('kp_favorite_team', team)
        else localStorage.removeItem('kp_favorite_team')
        return
      }
      const userId = session.user.id
      await supabase
        .from('user_settings')
        .upsert({ user_id: userId, favorite_team: team }, { onConflict: 'user_id' })
    },
    [session?.user.id, supabase],
  )

  useEffect(() => {
    if (!supabase || !session?.user.id) {
      setFavoriteTeamState(localStorage.getItem('kp_favorite_team'))
      return
    }
    const userId = session.user.id
    void supabase
      .from('user_settings')
      .select('favorite_team')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        const team = (data?.favorite_team as string | null | undefined) ?? null
        setFavoriteTeamState(team)
        if (team) localStorage.setItem('kp_favorite_team', team)
      })
  }, [session?.user.id, supabase])

  useEffect(() => {
    if (!supabase || !session?.user.id) return
    const userId = session.user.id
    void (async () => {
      const { data } = await supabase
        .from('user_settings')
        .select('display_name')
        .eq('user_id', userId)
        .maybeSingle()
      const current = String(data?.display_name ?? '').trim()
      if (current) return

      let candidate = randomDisplayName()
      for (let i = 0; i < 5; i += 1) {
        const { count } = await supabase
          .from('user_settings')
          .select('user_id', { count: 'exact', head: true })
          .eq('display_name', candidate)
        if (!count) break
        candidate = randomDisplayName()
      }

      await supabase
        .from('user_settings')
        .upsert({ user_id: userId, display_name: candidate }, { onConflict: 'user_id' })
    })()
  }, [session?.user.id, supabase])

  const palette = useMemo(() => paletteForTeam(favoriteTeam), [favoriteTeam])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--color-primary', palette.primary)
    root.style.setProperty('--color-secondary', palette.secondary)
    root.style.setProperty('--color-accent', palette.accent)
    root.style.setProperty('--color-bg', palette.bg)
    root.style.setProperty('--color-surface', palette.surface)
    root.style.setProperty('--color-text', palette.text)
    root.style.setProperty('--color-muted', 'rgba(215, 226, 244, 0.72)')
  }, [palette])

  const signInWithOtp = useCallback(
    async (email: string) => {
      if (!supabase) return { ok: false as const, message: 'Supabase not configured' }
      const { error } = await supabase.auth.signInWithOtp({ email })
      return error ? { ok: false as const, message: error.message } : { ok: true as const }
    },
    [supabase],
  )

  const verifyOtp = useCallback(
    async (email: string, token: string) => {
      if (!supabase) return { ok: false as const, message: 'Supabase not configured' }
      const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' })
      return error ? { ok: false as const, message: error.message } : { ok: true as const }
    },
    [supabase],
  )

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) return { ok: false as const, message: 'Supabase not configured' }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/account` },
    })
    return error ? { ok: false as const, message: error.message } : { ok: true as const }
  }, [supabase])

  const signOut = useCallback(async () => {
    if (!supabase) return
    await supabase.auth.signOut()
  }, [supabase])

  const value: AuthCtx = {
    supabase,
    session,
    ready,
    hasSubscription,
    hasPlus,
    subscriptionReady,
    favoriteTeam,
    palette,
    signInWithOtp,
    verifyOtp,
    signInWithGoogle,
    setFavoriteTeam,
    refreshSubscription,
    signOut,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWebAuth() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useWebAuth must be inside WebAuthProvider')
  return c
}
