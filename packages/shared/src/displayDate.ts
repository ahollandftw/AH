/**
 * Returns the ISO date string the app should display data for.
 *
 * Until 2026-03-27 (exclusive) the app shows Opening Day data (2026-03-26).
 * From 2026-03-27 onward it returns today's date in America/New_York.
 */
export function getAppDisplayDateIso(): string {
  const OPENING_DAY = '2026-03-26'
  const SWITCH_DATE = '2026-03-27'

  const nowEst = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
  )
  const y = nowEst.getFullYear()
  const m = String(nowEst.getMonth() + 1).padStart(2, '0')
  const d = String(nowEst.getDate()).padStart(2, '0')
  const todayIso = `${y}-${m}-${d}`

  return todayIso < SWITCH_DATE ? OPENING_DAY : todayIso
}
