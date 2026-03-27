import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { WebAuthProvider } from './auth/WebAuthProvider.tsx'
import { useWebAuth } from './auth/WebAuthProvider.tsx'
import LeaderboardPage from './pages/LeaderboardPage.tsx'
import DugoutPage from './pages/DugoutPage.tsx'
import ProjectionsPage from './pages/ProjectionsPage.tsx'
import AccountPage from './pages/AccountPage.tsx'
import CommunityLeaderboardPage from './pages/CommunityLeaderboardPage.tsx'
import FriendsPage from './pages/FriendsPage.tsx'
import HelpPage from './pages/HelpPage.tsx'
import WallOfBangPage from './pages/WallOfBangPage.tsx'
import appLogo from '../../../data/logo.svg'
import './leaderboard.css'

function Layout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { session, supabase, waiverAccepted } = useWebAuth()
  const [profileName, setProfileName] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const fullLinks = [
    ['/dugout', 'Dugout', '⚾'],
    ['/projections', 'Projections', '📈'],
    ['/stats', 'Homer Tracking', '📊'],
    ['/community', 'Leaderboard', '🏆'],
    ['/wall', 'Wall of Bang', '💥'],
  ] as const
  const menuLinks = [
    ['/dugout', 'Dugout'],
    ['/projections', 'Projections'],
    ['/stats', 'Homer Tracking'],
    ['/community', 'Leaderboard'],
    ['/wall', 'Wall of Bang'],
    ['/friends', 'Friends'],
    ['/help', 'Help'],
    ['/account', 'Account'],
  ] as const
  const links =
    session && !waiverAccepted
      ? ([['/account', 'Account', '👤']] as const)
      : fullLinks
  useEffect(() => {
    if (!supabase || !session?.user.id) {
      setProfileName(null)
      setAvatarUrl(null)
      return
    }
    void supabase
      .from('user_settings')
      .select('display_name,avatar_url')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        setProfileName((data?.display_name as string | null | undefined) ?? null)
        setAvatarUrl((data?.avatar_url as string | null | undefined) ?? null)
      })
  }, [session?.user.id, supabase])

  const displayName =
    profileName?.trim() ||
    session?.user.user_metadata?.preferred_username ||
    session?.user.user_metadata?.full_name ||
    session?.user.user_metadata?.name ||
    session?.user.email?.split('@')[0] ||
    null

  useEffect(() => {
    if (!menuOpen) return
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  useEffect(() => {
    const el = document.querySelector('.mainScroll') as HTMLElement | null
    if (!el) return
    let startY = 0
    let pulling = false

    const onStart = (e: TouchEvent) => {
      if (el.scrollTop > 0) return
      startY = e.touches[0]?.clientY ?? 0
      pulling = true
    }

    const onMove = (e: TouchEvent) => {
      if (!pulling) return
      if (el.scrollTop > 0) {
        pulling = false
        return
      }
      const y = e.touches[0]?.clientY ?? 0
      if (y - startY > 78) {
        pulling = false
        window.location.reload()
      }
    }

    const onEnd = () => {
      pulling = false
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
    }
  }, [])

  return (
    <div className="appRoot">
      <header className="topBanner" role="banner" aria-label="AnalyticHustle header">
        <div className="topBanner-side" ref={menuRef}>
          {!(session && !waiverAccepted) ? (
            <div className="appMenu">
              <button
                type="button"
                className="appMenu-burger"
                aria-label="Open menu"
                onClick={() => setMenuOpen((v) => !v)}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
              {menuOpen ? (
                <div className="appMenu-dropdown">
                  {menuLinks.map(([to, label]) => (
                    <button
                      key={to}
                      type="button"
                      className={`appMenu-item ${pathname === to ? 'is-active' : ''}`}
                      onClick={() => { navigate(to); setMenuOpen(false) }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <Link to="/dugout" className="topBanner-logoLink" aria-label="Go to Dugout">
          <span className="topBanner-logoFrame" style={{ ['--logo-url' as string]: `url("${appLogo}")` }}>
            <span className="topBanner-logoMask" aria-hidden="true" />
          </span>
        </Link>
        <div className="topBanner-side topBanner-side--right">
          {session ? (
            <Link to="/account" className="topBanner-account" title="Account">
              <span className="topBanner-userDot" aria-hidden="true">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" className="topBanner-userAvatar" />
                ) : (
                  String(displayName ?? 'U').slice(0, 1).toUpperCase()
                )}
              </span>
              <span className="topBanner-userName">{displayName}</span>
            </Link>
          ) : (
            <Link to="/account" className="topBanner-signIn" aria-label="Sign in">
              <span aria-hidden="true">👤</span>
            </Link>
          )}
        </div>
      </header>
      <main className="mainScroll" id="main-content">
        {session && !waiverAccepted && pathname !== '/account' ? (
          <Navigate to="/account" replace />
        ) : (
          <Outlet />
        )}
      </main>
      <footer className="bottomNav" role="navigation" aria-label="Main">
        {links.map(([to, label, icon]) => (
          <Link
            key={to}
            to={to}
            className={pathname === to ? 'bottomNav-link active' : 'bottomNav-link'}
          >
            <span className="bottomNav-icon" aria-hidden="true">
              {icon}
            </span>
            <span>{label}</span>
          </Link>
        ))}
      </footer>
    </div>
  )
}

export default function App() {
  return (
    <WebAuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Navigate to="/dugout" replace />} />
            <Route path="/dugout" element={<DugoutPage />} />
            <Route path="/projections" element={<ProjectionsPage />} />
            <Route path="/stats" element={<LeaderboardPage />} />
            <Route path="/community" element={<CommunityLeaderboardPage />} />
            <Route path="/wall" element={<WallOfBangPage />} />
            <Route path="/friends" element={<FriendsPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/watchlist" element={<Navigate to="/account" replace />} />
            <Route path="/leaderboard" element={<Navigate to="/community" replace />} />
            {/* TODO: re-enable login route when ready */}
            {/* <Route path="/login" element={<LoginPage />} /> */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WebAuthProvider>
  )
}
