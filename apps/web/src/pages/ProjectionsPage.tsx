import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  formatProbability,
  getAppDisplayDateIso,
  getGamesForDate,
  getScheduleDates,
  groupProjectionsByTier,
  listDailyHrProjections,
  type DailyProjection,
  type ScheduleGame,
} from '@kinetic/shared'
import { useWebAuth } from '../auth/WebAuthProvider.tsx'

function tierColor(k: string): string {
  switch (k) {
    case 'S': return '#ffdf00'
    case 'A': return '#00e639'
    case 'B': return '#adc8f5'
    case 'C': return '#8f9097'
    default: return '#44474d'
  }
}

export default function ProjectionsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { supabase, hasSubscription } = useWebAuth()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<DailyProjection[]>([])
  const [games, setGames] = useState<ScheduleGame[]>([])
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [displayDate, setDisplayDate] = useState(
    searchParams.get('date') ?? getAppDisplayDateIso(),
  )
  const selectedTeam = (searchParams.get('team') ?? '').toUpperCase()
  const selectedPlayerId = searchParams.get('player') ?? ''

  useEffect(() => {
    const qDate = searchParams.get('date')
    if (qDate && qDate !== displayDate) setDisplayDate(qDate)
  }, [displayDate, searchParams])

  useEffect(() => {
    if (!supabase) return
    void getScheduleDates(supabase).then((dates) => {
      if (!dates.length) return
      setAvailableDates(dates)
      if (!dates.includes(displayDate)) setDisplayDate(dates[0])
    })
  }, [supabase, displayDate])

  useEffect(() => {
    if (!supabase) return
    setLoading(true)
    void Promise.all([
      listDailyHrProjections(supabase, displayDate),
      getGamesForDate(supabase, displayDate),
    ])
      .then(([proj, sched]) => {
        setRows(proj)
        setGames(sched)
      })
      .finally(() => setLoading(false))
  }, [supabase, displayDate])

  const filteredRows = useMemo(() => {
    let out = rows
    if (!hasSubscription && games.length > 0) {
      const idx =
        displayDate.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % games.length
      const g = games[idx]
      const allowed = new Set([g.awayTeam, g.homeTeam])
      out = out.filter((r) => r.team && allowed.has(r.team))
    }
    if (selectedTeam) out = out.filter((r) => (r.team ?? '').toUpperCase() === selectedTeam)
    if (selectedPlayerId) out = out.filter((r) => r.playerId === selectedPlayerId)
    return out
  }, [displayDate, games, hasSubscription, rows, selectedPlayerId, selectedTeam])

  const selectedPlayer = useMemo(
    () => rows.find((r) => r.playerId === selectedPlayerId) ?? null,
    [rows, selectedPlayerId],
  )

  const sections = useMemo(
    () =>
      groupProjectionsByTier(filteredRows).map((g) => ({
        key: g.tierKey,
        label: g.tierLabel.toUpperCase(),
        data: g.data,
      })),
    [filteredRows],
  )

  return (
    <div className="pg">
      <h1 className="pg-title">Projections</h1>
      <div className="pg-controls">
        <label htmlFor="proj-date" className="pg-label">
          Date
        </label>
        <input
          id="proj-date"
          className="pg-date"
          type="date"
          value={displayDate}
          min={availableDates[0]}
          max={availableDates[availableDates.length - 1]}
          onChange={(e) => {
            const nextDate = e.target.value
            setDisplayDate(nextDate)
            const next = new URLSearchParams(searchParams)
            next.set('date', nextDate)
            setSearchParams(next, { replace: true })
          }}
        />
        {(selectedTeam || selectedPlayerId) && (
          <button
            type="button"
            className="pg-clearBtn"
            onClick={() => {
              const next = new URLSearchParams(searchParams)
              next.delete('team')
              next.delete('player')
              setSearchParams(next, { replace: true })
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      <p className="pg-sub">
        {displayDate} &mdash; {games.length} game{games.length !== 1 ? 's' : ''} &mdash;{' '}
        {filteredRows.length && filteredRows[0]?.source === 'stats_homeruns'
          ? 'Ranked by xhr (schedule-filtered).'
          : 'Daily launch — grouped by tier.'}
      </p>
      {!hasSubscription ? (
        <p className="pg-sub">Free preview: one random game. Subscribe to unlock full projections.</p>
      ) : null}
      {(selectedTeam || selectedPlayer) && (
        <div className="pg-focusCard">
          {selectedTeam ? <div className="pg-focusLine">Team filter: {selectedTeam}</div> : null}
          {selectedPlayer ? (
            <div className="pg-focusLine">
              Matchup: {selectedPlayer.name} ({selectedPlayer.team ?? '—'}){' '}
              {selectedPlayer.opponent ?? 'matchup pending'}
            </div>
          ) : null}
        </div>
      )}
      {loading ? (
        <div className="lb-skel">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="lb-skelRow" />
          ))}
        </div>
      ) : sections.length === 0 ? (
        <p className="pg-empty">No games scheduled or projection data for {displayDate}.</p>
      ) : (
        sections.map((s) => (
          <div key={s.key} style={{ marginBottom: 24 }}>
            <div
              className="pg-tier"
              style={{ borderLeftColor: tierColor(s.key), color: tierColor(s.key) }}
            >
              {s.label}
            </div>
            <div className="pg-cards">
              {s.data.map((r) => (
                <div key={r.playerId} className="pg-card">
                  <div className="pg-info">
                    <span className="pg-name">{r.name}</span>
                    <span className="pg-meta">
                      {(r.team ?? '—').toUpperCase()} &bull; {(r.position ?? '—').toUpperCase()}
                    </span>
                    {r.opponent ? (
                      <span className="pg-matchup">{r.opponent}</span>
                    ) : r.opponentPitcher ? (
                      <span className="pg-matchup">
                        vs {r.opponentPitcher}{' '}
                        {r.opponentPitcherHand ? `(${r.opponentPitcherHand})` : ''}
                      </span>
                    ) : null}
                  </div>
                  <div className="pg-right">
                    <span className="pg-prob">{formatProbability(r.hrProbability)}</span>
                    {r.l7Hrs != null ? (
                      <span className="pg-small">L7 HRs: {r.l7Hrs}</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
