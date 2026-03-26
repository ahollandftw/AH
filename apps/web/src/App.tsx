import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { WebAuthProvider } from './auth/WebAuthProvider.tsx'
import { useWebAuth } from './auth/WebAuthProvider.tsx'
import LeaderboardPage from './pages/LeaderboardPage.tsx'
import DugoutPage from './pages/DugoutPage.tsx'
import ProjectionsPage from './pages/ProjectionsPage.tsx'
import AccountPage from './pages/AccountPage.tsx'
import CommunityLeaderboardPage from './pages/CommunityLeaderboardPage.tsx'
import FriendsPage from './pages/FriendsPage.tsx'
import HelpPage from './pages/HelpPage.tsx'
import appLogo from '../../../data/logo.svg'
import './leaderboard.css'

function Layout() {
  const { pathname } = useLocation()
  const { session, supabase } = useWebAuth()
  const [profileName, setProfileName] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const links = [
    ['/dugout', 'Dugout', '⚾'],
    ['/projections', 'Projections', '📈'],
    ['/stats', 'Stats', '📊'],
    ['/community', 'Leaderboard', '🏆'],
    ['/friends', 'Friends', '👥'],
    ['/help', 'Help', '❓'],
  ] as const
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

  return (
    <div className="appRoot">
      <header className="topBanner" role="banner" aria-label="AnalyticHustle header">
        <div className="topBanner-side" />
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
        <Outlet />
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
