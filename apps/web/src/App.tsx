import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { WebAuthProvider } from './auth/WebAuthProvider.tsx'
import LeaderboardPage from './pages/LeaderboardPage.tsx'
import DugoutPage from './pages/DugoutPage.tsx'
import ProjectionsPage from './pages/ProjectionsPage.tsx'
import AccountPage from './pages/AccountPage.tsx'
import './leaderboard.css'

function Layout() {
  const { pathname } = useLocation()
  const links = [
    ['/dugout', 'Dugout', '⚾'],
    ['/projections', 'Projections', '📈'],
    ['/stats', 'Stats', '📊'],
    ['/account', 'Account', '👤'],
  ] as const

  return (
    <div className="appRoot">
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
            <Route path="/account" element={<AccountPage />} />
            <Route path="/watchlist" element={<Navigate to="/account" replace />} />
            <Route path="/leaderboard" element={<Navigate to="/stats" replace />} />
            {/* TODO: re-enable login route when ready */}
            {/* <Route path="/login" element={<LoginPage />} /> */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WebAuthProvider>
  )
}
